import { enumIndex } from './enums.mjs'
import { argumentChanges } from './argument-changes.mjs'
import { isTestFile, trackTestCases } from './test-cases.mjs'

const languages = {
  c: /\.(?:c|cc|cpp|cxx|h|hh|hpp)$/i,
  js: /\.(?:[cm]?[jt]s|[jt]sx)$/i,
  rust: /\.rs$/i,
  kotlin: /\.kts?$/i,
}
const keywords = new Set('if else while for switch catch when match return throw sizeof alignof typeof decltype static_assert assert_eq fn fun function async await super this new void'.split(' '))

export function filePath(header, prefixLength = 2) {
  if (!header.startsWith('"')) return header.split('\t')[0].slice(prefixLength)
  // Git quotes non-ASCII path bytes as octal escapes.
  const bytes = []
  for (const match of header.match(/^"((?:\\.|[^"\\])*)"/)?.[1].matchAll(/\\([0-7]{3}|.)|([^\\])/gs) ?? []) {
    if (!match[1]) bytes.push(...new TextEncoder().encode(match[2]))
    else if (match[1].length === 3) bytes.push(parseInt(match[1], 8))
    else bytes.push(({ t: 9, n: 10, r: 13, a: 7, b: 8, v: 11, f: 12 })[match[1]] ?? match[1].charCodeAt(0))
  }
  return new TextDecoder().decode(Uint8Array.from(bytes)).slice(prefixLength)
}

function declaration(code, language, header = false) {
  const patterns = {
    rust: /\bfn\s+(\w+)/,
    kotlin: /\bfun\s+(?:[\w.]+\.)?(\w+)\s*\(/,
    js: /\bfunction\s*\*?\s*([\w$]+)|\b(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:\([^)]*\)|[\w$]+)\s*=>/,
  }
  const explicit = patterns[language]?.exec(code)
  if (explicit) return explicit[1] ?? explicit[2]
  if (language !== 'js' && language !== 'c') return
  if (/^\s*(?:return|throw|new|else|case|if|while|switch|for)\b/.test(code)) return
  if (language === 'c') {
    const multiline = code.match(/^\s*(?:[\w:<>,~*&]+\s+)+(?:[\w:]+::)?[*&~]*(\w+)\s*\(\s*$/)
    if (multiline) return multiline[1]
    if (header) {
      const truncated = /^\s*(?:[\w:<>,~*&]+\s+)+(?:[\w:]+::)?[*&~]*(\w+)\s*\([^();]*$/.exec(code)
      if (truncated && !keywords.has(truncated[1])) return truncated[1]
    }
  }
  const method = code.match(/^\s*(?:[\w:<>,~*&]+\s+)*(?:[\w:]+::)?[*&~]*([\w$]+)\s*\([^();]*\)\s*(?:const\s*)?(?:noexcept\s*)?(?::\s*[\w<>[\]| ]+)?\s*(.*)$/)
  if (!method || keywords.has(method[1])) return
  const typed = /\s/.test(code.trim().split('(')[0])
  if (language === 'c' && typed && /^;\s*$/.test(method[2])) return method[1]
  if (method[2].startsWith('{') || (language === 'c' && method[2] === '' && (header || typed))) return method[1]
}

// Mask comments and literals before counting braces and finding calls.
function maskLine(line, state, language) {
  return line.replace(/\/\*|\*\/|\/\/|\\.|["'`]|[^/*\\"'`]+|./g, (part, index) => {
    const end = state.end
    if (end) {
      if (part === end) state.end = ''
    } else if (part === '/*') state.end = '*/'
    else if (part === '//') state.end = '\n'
    else if (part === "'" && language === 'rust' && /[a-zA-Z_]/.test(line[index + 1] ?? '') && line[index + 2] !== "'") return part
    else if (/^["'`]$/.test(part)) state.end = part
    else return part
    return ' '.repeat(part.length)
  })
}

function callArguments(source, masked, open) {
  let start = open + 1
  let end = start
  let depth = 1
  let nested = 0
  const args = []
  for (; end < masked.length && depth; end++) {
    const token = masked[end]
    if (token === '(') depth++
    if (token === ')') depth--
    if (token === '[' || token === '{') nested++
    if (token === ']' || token === '}') nested--
    if ((depth === 1 && !nested && token === ',') || !depth) {
      const arg = source.slice(start, end).trim()
      if (arg) args.push(arg)
      start = end + 1
    }
  }
  const text = source.slice(open, end)
  const simple = !depth && !nested && !text.includes('/*') && !text.includes('//') && !/[<>/]/.test(masked.slice(open, end).replaceAll('->', ''))
  return { text, args: simple ? args : null }
}

function renameText(source, masked, name) {
  return source.replace(/[\w$]+/g, (word, index) => {
    if (word !== name || !masked.startsWith(word, index)) return word
    return /^\s*[(=<]/.test(masked.slice(index + word.length)) ? '\0' : word
  })
}

function readSide(diff, side, changedCalls, candidates, edits, referenceHunks) {
  const fileHeader = side === 'L' ? '--- ' : '+++ '
  const marker = side === 'L' ? '-' : '+'
  // shortcut: Calls are grouped by language and name. Use a symbol index to distinguish overloads.
  const nodes = new Map()
  const lines = new Map()
  const cases = []
  let tests, hunkRows
  let fileIndex = 0
  let hunkIndex = 0
  let context = 0
  let path, language, row, owner, ownerIndent, depth, lexical, parents
  function node(name) {
    const id = language + ':' + name
    if (!nodes.has(id)) nodes.set(id, { id, name, definitions: [], changes: new Map(), incoming: [], outgoing: [], changed: false })
    return nodes.get(id)
  }

  for (const [index, line] of diff.split(/\r?\n/).entries()) {
    if (line.startsWith('diff --git ')) {
      fileIndex++
      hunkIndex = 0
      tests = undefined
      language = undefined
      row = undefined
      path = undefined
      continue
    }
    if (row === undefined && line.startsWith(fileHeader)) {
      path = filePath(line.slice(4))
      language = Object.keys(languages).find(key => languages[key].test(path))
      if (language) lines.set(path, new Map())
      if (language && isTestFile(path)) tests = trackTestCases(path, language, cases)
      continue
    }
    if (!language) continue
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/)
    if (hunk) {
      if (referenceHunks) {
        hunkRows = []
        referenceHunks.push({ path, language, rows: hunkRows })
      }
      hunkIndex++
      context = 0
      row = Number(side === 'L' ? hunk[1] : hunk[2])
      const heading = hunk[3].slice(1)
      tests?.hunk(heading)
      const name = declaration(heading, language, true)
      owner = name ? node(name) : undefined
      ownerIndent = heading.search(/\S/)
      depth = null
      lexical = {}
      parents = []
      continue
    }
    if (side === 'R' && line[0] === '-') tests?.removed(index)
    if (line[0] === ' ') context++
    if (row === undefined || (line[0] !== marker && line[0] !== ' ')) continue
    const number = row++
    const added = line[0] === '+'
    const source = line.slice(1)
    const continuedLiteral = Boolean(lexical.end)
    const code = maskLine(source, lexical, language)
    hunkRows?.push({ number, source, code, added })
    if (lexical.end !== '`' && lexical.end !== '*/') lexical.end = ''
    const name = declaration(code, language)
    const prototype = name && language === 'c' && /;\s*$/.test(code) && !code.includes('{')
    if (language === 'c' && owner && depth === null && code.search(/\S/) <= ownerIndent &&
        (prototype || /^\s*(?:typedef\s+)?enum\b[^;]*\{/.test(code))) {
      owner = undefined
    }
    if (name) {
      if (owner) parents.push({ owner, depth, ownerIndent })
      owner = node(name)
      const site = { path, number, added }
      if (prototype) site.prototypeKey = JSON.stringify([fileIndex, renameText(source, code, name).trim()])
      owner.definitions.push(site)
      if (!prototype && line[0] === marker) candidates.set(owner, { owner, path, language, fileIndex, hunkIndex, rows: [] })
      ownerIndent = code.search(/\S/)
      depth = 0
    }
    if (added && owner) {
      owner.changed = true
      if (!owner.changes.has(path)) owner.changes.set(path, { path, number, added })
    }
    let body = code
    if (name) {
      const expression = language === 'kotlin' ? code.indexOf('=', code.indexOf(')') + 1) : -1
      const arrow = language === 'js' ? code.indexOf('=>') : -1
      const brace = code.indexOf('{', code.indexOf('('))
      if (brace >= 0 && (arrow < 0 || brace < arrow)) body = code.slice(brace + 1)
      else if (arrow >= 0) body = code.slice(arrow + 2)
      else if (expression >= 0) body = code.slice(expression + 1)
      else body = ''
    }
    const calls = []
    for (const match of body.matchAll(/(?<![\w$])((?:[a-zA-Z_$][\w$]*\s*(?:\?\.|\.|->|::)\s*)*)([a-zA-Z_$][\w$]*)\s*\(/g)) {
      const [, qualifier, callee] = match
      if (keywords.has(callee)) continue
      const target = node(callee)
      const site = { owner, target, path, number, added }
      if (line[0] === marker) {
        const open = code.length - body.length + match.index + match[0].length - 1
        const args = callArguments(source, code, open)
        changedCalls.push({ fileIndex, qualifier: qualifier.replace(/\s/g, ''), site, ...args, block: [fileIndex, hunkIndex, context] })
      }
      calls.push(target)
      target.incoming.push(site)
      owner?.outgoing.push(site)
    }
    tests?.line(source, code, number, line[0] === marker, calls, index)
    if (owner || calls.length || line[0] === marker) {
      const row = { owner, calls, source: line }
      if (added) Object.assign(row, { changedCode: code, language })
      lines.get(path).set(number, row)
      if (line[0] === marker) edits.push({ block: fileIndex + '/' + hunkIndex + '/' + context, row, code, language, path, number })
      const candidate = candidates.get(owner)
      if (!prototype && candidate?.path === path) {
        let text = renameText(source, code, owner.name)
        if (language === 'c' && !continuedLiteral) text = text.trimStart()
        candidate.rows.push({ row, text, number })
      }
    }
    if (!owner) continue
    if (depth === null) {
      if (/^\s*}/.test(code) && code.search(/\S/) <= ownerIndent) owner = undefined
    } else {
      depth += (code.match(/{/g)?.length ?? 0) - (code.match(/}/g)?.length ?? 0)
      if (depth <= 0 && (code.includes('}') || (name && /=>|;\s*$/.test(code)) || (language === 'kotlin' && code.includes('=')))) owner = undefined
    }
    if (!owner && parents.length) {
      const parent = parents.pop()
      owner = parent.owner
      depth = parent.depth
      ownerIndent = parent.ownerIndent
    }
  }
  const assertions = new Map()
  const testCases = cases.filter(test => test.patchLines.size)
  for (const { name, path, targets, checks, evidence } of testCases) {
    for (const { words, code, number, language } of evidence) {
      for (const word of words) {
        const key = language + ':' + word
        if (!assertions.has(key)) assertions.set(key, [])
        assertions.get(key).push({ name, path, code, number })
      }
    }
    for (const [target, number] of targets) {
      target.tests ??= []
      target.tests.push({ name, path, number, checks })
    }
  }
  return { nodes, lines, assertions, testCases }
}

function matchRenames(removed, added, before, after) {
  const renamedLines = new Map()
  function markPair(path, left, right) {
    left.row.renameContext = true
    right.row.renameContext = true
    if (right.row.source[0] !== '+') return
    if (right.row.renameDeclaration) right.row.previousDeclaration = left.row.source.slice(1)
    if (!renamedLines.has(path)) renamedLines.set(path, { left: [], right: [] })
    const lines = renamedLines.get(path)
    lines.left.push(left.number)
    lines.right.push(right.number)
  }

  function unmatched(candidates, other) {
    return [...candidates.values()].filter(({ owner }) =>
      owner.definitions.filter(site => !site.prototypeKey).length === 1 && !other.nodes.get(owner.id)?.definitions.length && !owner.renamedTo && !owner.renamedFrom)
  }

  // Match a complete body first. An edited body also needs a shared line in the same hunk.
  for (const exact of [true, false]) {
    const key = ({ fileIndex, language, hunkIndex, rows }) => JSON.stringify(exact
      ? [fileIndex, language, rows.map(({ text }) => text)]
      : [fileIndex, language, hunkIndex, rows[0].text])
    const oldGroups = Map.groupBy(unmatched(removed, after), key)
    for (const [signature, next] of Map.groupBy(unmatched(added, before), key)) {
      const previous = oldGroups.get(signature)
      if (previous?.length !== 1 || next.length !== 1) continue
      const [old] = previous
      const [current] = next
      const body = new Set(old.rows.slice(1).map(({ text }) => text))
      if (!exact && !current.rows.slice(1).some(({ text }) => /[\w$]/.test(text) && body.has(text))) continue

      old.owner.renamedTo = current.owner
      current.owner.renamedFrom = old.owner.name
      const prototypes = old.owner.definitions.filter(site => site.prototypeKey && before.lines.get(site.path).get(site.number).source[0] === '-')
      const oldPrototypes = Map.groupBy(prototypes.reverse(), site => site.prototypeKey)
      for (const site of current.owner.definitions) {
        if (site.prototypeKey) {
          if (!site.added) continue
          const left = oldPrototypes.get(site.prototypeKey)?.pop()
          if (!left) continue
          const oldRow = before.lines.get(left.path).get(left.number)
          const newRow = after.lines.get(site.path).get(site.number)
          newRow.renameDeclaration = true
          markPair(site.path, { row: oldRow, number: left.number }, { row: newRow, number: site.number })
        }
        site.added = false
      }
      current.rows[0].row.renameDeclaration = true
      const sameLine = ({ row, text }) => (row.source[0] === ' ' ? ' ' : '*') + text
      const positions = Map.groupBy(old.rows.map((entry, index) => ({ ...entry, index })).reverse(), sameLine)
      let last = -1
      for (const entry of current.rows) {
        const matches = positions.get(sameLine(entry))
        while (matches?.length && matches.at(-1).index <= last) matches.pop()
        const match = matches?.pop()
        if (!match) continue
        last = match.index
        markPair(current.path, match, entry)
      }
    }
  }
  return renamedLines
}

function groupRenameUses(edits, graph, previous) {
  const uses = []
  for (const { block, row, code, language, path, number } of edits) {
    const symbols = new Set()
    const normalized = row.source.slice(1).replace(/[\w$]+/g, (word, index) => {
      if (!code.startsWith(word, index)) return word
      const node = graph.nodes.get(language + ':' + word)
      const symbol = previous ? node?.renamedTo : node
      if (!symbol?.renamedFrom) return word
      if (!node.definitions.some(site => site.path === path && site.number === number)) symbols.add(symbol)
      return symbol.name
    })
    for (const symbol of symbols) uses.push({ key: block + '/' + symbol.id, row, normalized, symbol, number })
  }
  return Map.groupBy(uses, use => use.key)
}

function connectRenameUses(oldEdits, newEdits, before, after) {
  if (![...after.nodes.values()].some(node => node.renamedFrom)) return
  const left = groupRenameUses(oldEdits, before, true)
  for (const [key, added] of groupRenameUses(newEdits, after, false)) {
    const removed = left.get(key)
    if (!removed) continue
    const byText = Map.groupBy(removed.slice().reverse(), use => use.normalized)
    const matched = new Set()
    const remaining = []
    function link(old, current, pure) {
      current.row.renameUses ??= []
      current.row.renameUses.push({ symbol: current.symbol, before: old.row.source.slice(1), number: old.number, pure })
      if (pure) old.row.onlyRenameUses = current.row.onlyRenameUses = true
    }
    for (const use of added) {
      const old = byText.get(use.normalized)?.pop()
      if (old) {
        matched.add(old)
        link(old, use, true)
      } else remaining.push(use)
    }
    if (remaining.length === 1 && removed.length === matched.size + 1) {
      link(removed.find(use => !matched.has(use)), remaining[0], false)
    }
  }
}

function indexStaticVariables(hunks, lines) {
  for (const [path, parts] of Map.groupBy(hunks.filter(hunk => hunk.language === 'c'), hunk => hunk.path)) {
    const variables = new Map()
    const file = lines.get(path)
    for (const { rows } of parts) for (const row of rows) {
      const line = file.get(row.number)
      if (!row.added || line?.owner) continue
      const match = /^\s*static\s+(?:[\w\s]+?|_Atomic\s*\(\s*\w+\s*\))\s*\**\s*\b([A-Za-z_]\w*)\s*(?:\[[^\]]*\]\s*)*(?:=[^;]*)?;\s*$/.exec(row.code)
      if (!match) continue
      const variable = { name: match[1], uses: [] }
      variables.set(variable.name, variable)
      line.variable = variable
    }
    if (!variables.size) continue
    for (const { rows } of parts) {
      const scopes = [new Set()]
      let parameters = new Set()
      for (const row of rows) {
        const uses = new Map()
        for (const token of row.code.matchAll(/[{};]|(?:(\.|->|::)\s*)?\b([A-Za-z_]\w*)/g)) {
          if (token[0] === '{') {
            scopes.push(parameters)
            parameters = new Set()
          } else if (token[0] === '}') {
            if (scopes.length > 1) scopes.pop()
            else scopes[0].clear()
          } else if (token[0] === ';') parameters.clear()
          const variable = variables.get(token[2])
          if (!variable || token[1] || file.get(row.number)?.variable === variable) continue
          const prefix = row.code.slice(0, token.index)
          if (/\b(?:char|short|int|long|float|double|unsigned|signed|bool|\w+_t|(?:struct|enum|union)\s+\w+)\b[\s*]*$/.test(prefix)) {
            const scope = scopes.length === 1 && /\([^)]*$/.test(prefix) ? parameters : scopes.at(-1)
            scope.add(variable)
            continue
          }
          if (scopes.some(scope => scope.has(variable))) continue
          if (!uses.has(variable)) {
            const highlights = []
            uses.set(variable, highlights)
            variable.uses.push({ path, number: row.number, end: row.number, added: row.added,
              preview: [(row.added ? '+' : ' ') + row.source], highlights })
          }
          const start = token.index + Number(row.added)
          uses.get(variable).push([start, start + variable.name.length])
        }
      }
    }
  }
}

export function buildGraph(diff, side = 'R') {
  const removed = [], added = []
  const oldEdits = [], newEdits = []
  const oldFunctions = new Map(), newFunctions = new Map()
  const before = readSide(diff, 'L', removed, oldFunctions, oldEdits)
  if (side === 'L') return before
  const referenceHunks = /\b(?:static|enum)\b/.test(diff) ? [] : undefined
  const graph = readSide(diff, 'R', added, newFunctions, newEdits, referenceHunks)
  if (referenceHunks) indexStaticVariables(referenceHunks, graph.lines)
  const renamedLines = matchRenames(oldFunctions, newFunctions, before, graph)
  connectRenameUses(oldEdits, newEdits, before, graph)
  const key = ({ fileIndex, qualifier, site: { owner, target } }) =>
    JSON.stringify([fileIndex, (owner?.renamedTo ?? owner)?.id, qualifier, (target.renamedTo ?? target).id])
  const oldSites = Map.groupBy(removed, key)
  for (const [callee, sites] of Map.groupBy(added, key)) {
    const previous = oldSites.get(callee)
    if (!previous) continue
    const counts = new Map()
    for (const { text } of previous) counts.set(text, (counts.get(text) ?? 0) + 1)
    let remaining = previous.length
    for (const { site, text } of sites) {
      const count = counts.get(text)
      if (count) {
        site.added = false
        counts.set(text, count - 1)
        remaining--
      }
    }
    // Pair edited calls after matching identical calls, so a duplicate gets its own marker.
    for (const { site } of sites) {
      if (!remaining) break
      if (site.added) {
        site.added = false
        remaining--
      }
    }
  }
  return { ...graph, before, enums: enumIndex(referenceHunks ?? []), renamedLines, argumentChanges: argumentChanges(removed, added) }
}

export function selectionAt(graph, name, path, number) {
  if (path) {
    const line = graph.lines.get(path)?.get(number)
    return line?.calls.find(target => target.name === name) ?? line?.owner
  }
  if (!name) return
  const matches = [...graph.nodes.values()].filter(node => node.name === name)
  if (matches.length === 1) return matches[0]
}

export function pullRequest(url) {
  return url?.match(/^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)\/(?:changes|files)(?:[/?#]|$)/)
}

export async function fileHash(path) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(path))
  const hash = Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('')
  return '#diff-' + hash
}

export async function lineHash(path, number, side = 'R', end = number) {
  const anchor = await fileHash(path) + side + number
  return end > number ? anchor + '-' + side + end : anchor
}
