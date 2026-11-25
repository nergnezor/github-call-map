import { filePath } from './graph.mjs'
import { isTestDirectory, isTestFile } from './test-cases.mjs'

const sourceFile = /\.(?:[cm]?[jt]sx?|c|cc|cpp|cxx|h|hh|hpp|hxx|inl|inc|s|asm|m|mm|swift|kt|kts|java|rs|go|py|rb|sh|bash|zsh|cs|fs|scala|lua|php|dart|ex|exs|vue|svelte|zig)$/i

export function headerPath(header) {
  const paths = header.slice('diff --git '.length)
  const middle = (paths.length - 1) / 2
  if (paths[middle] === ' ' && /^(?:b\/|"b\/)/.test(paths.slice(middle + 1))) return filePath(paths.slice(middle + 1))
  const destination = paths.match(/ ("b\/(?:\\.|[^"\\])*"|b\/.*)$/)
  return filePath(destination?.[1] ?? paths)
}

function inlineEdit(before, after) {
  if (before.trim() === after.trim()) return
  const left = Array.from(before)
  const right = Array.from(after)
  const limit = Math.min(left.length, right.length)
  let start = 0, end = 0
  while (start < limit && left[start] === right[start]) start++
  while (end < limit - start && left[left.length - 1 - end] === right[right.length - 1 - end]) end++
  const prefix = left.slice(0, start).join('')
  const suffix = left.slice(left.length - end).join('')
  const shared = (prefix + suffix).trim()
  if (!/[\p{L}\p{N}_]/u.test(shared) || shared.length * 2 < Math.max(before.trim().length, after.trim().length)) return
  return {
    prefix, suffix,
    removed: left.slice(start, left.length - end).join(''),
    added: right.slice(start, right.length - end).join(''),
  }
}

export function changeTree(diff, graph, changedLines) {
  const old = graph.before
  const functions = new Map()
  const files = []
  function groupFor(owner) {
    if (!functions.has(owner.id)) {
      functions.set(owner.id, { label: owner.renamedFrom ? owner.renamedFrom + ' → ' + owner.name : owner.name, symbol: graph.nodes.get(owner.id)?.id, children: [] })
    }
    return functions.get(owner.id)
  }
  let file, oldLine, newLine, block
  const lines = diff.split(/\r?\n/)
  for (const [index, line] of lines.entries()) {
    if (line.startsWith('diff --git ')) {
      file = { label: headerPath(line), children: [], insertions: 0, deletions: 0 }
      files.push(file)
      oldLine = undefined
      block = null
      continue
    }
    if (!file) continue
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      file.isTest ??= isTestFile(file.label)
      oldLine = Number(hunk[1])
      newLine = Number(hunk[2])
      block = null
      continue
    }
    if (oldLine === undefined) {
      if (line.startsWith('--- a/') || line.startsWith('--- "a/')) {
        file.oldPath = filePath(line.slice(4))
        file.label = file.oldPath
      }
      if (line.startsWith('+++ b/') || line.startsWith('+++ "b/')) file.label = filePath(line.slice(4))
      if (/^(rename|copy) to /.test(line)) file.label = filePath(line.slice(line.indexOf(' to ') + 4), 0)
      continue
    }
    if (line[0] === ' ') {
      oldLine++
      newLine++
      block = null
    }
    if (line[0] !== '+' && line[0] !== '-') continue
    const added = line[0] === '+'
    const number = added ? newLine++ : oldLine++
    const side = added ? 'R' : 'L'
    if (file.isTest) (file.patchLines ??= []).push(index)
    if (added) file.insertions++
    else file.deletions++
    const row = added ? graph.lines.get(file.label)?.get(number) : old.lines.get(file.oldPath)?.get(number)
    const owner = row?.owner?.renamedTo ?? row?.owner
    for (const use of row?.renameUses ?? []) {
      if (file.isTest && (!use.pure || row.renameDeclaration)) continue
      const site = { path: file.label, number, end: number, preview: [line.slice(1)],
        inline: inlineEdit(use.before, line.slice(1)), renameLocation: true, mixedRename: !use.pure }
      if (use.pure) site.previous = { path: file.label, side: 'L', number: use.number, end: use.number, preview: ['-' + use.before] }
      if (file.isTest) {
        file.children.push({ site })
        break
      }
      groupFor(use.symbol).children.push({ site })
    }
    if ((row?.onlyRenameUses || row?.renameContext) && !row.renameDeclaration) {
      block = null
      continue
    }
    const parent = owner && !file.isTest ? groupFor(owner) : file
    if (row?.renameDeclaration) {
      if (row.previousDeclaration !== undefined) row.inline = inlineEdit(row.previousDeclaration, line.slice(1))
      parent.children.push({ site: { path: file.label, number, end: number, preview: [line.slice(1)], inline: row.inline, renameLocation: true } })
      block = null
    } else if (block && block.parent === parent && block.site.side === side) {
      block.site.end = number
      block.site.preview.push(line)
    } else {
      const site = { path: file.label, number, end: number, side, preview: [line] }
      if (added && block?.parent === parent && parent.children.at(-1)?.site === block.site && block.site.side === 'L' && block.site.number === block.site.end &&
          lines[index - 1]?.startsWith('-') && !lines[index - 2]?.startsWith('-') && !lines[index + 1]?.startsWith('+')) {
        const edit = inlineEdit(block.site.preview[0].slice(1), line.slice(1))
        if (edit) {
          site.inline = edit
          site.previous = parent.children.pop().site
          if (row) row.inline = edit
        }
      }
      parent.children.push({ site })
      block = { parent, site }
    }
  }

  const roots = [...functions.values()]
  for (const file of files) {
    changedLines?.set(file.label, { added: file.insertions, removed: file.deletions })
    if (!file.insertions && !file.deletions) file.site = { path: file.label }
    if (file.isTest ?? isTestFile(file.label)) file.testPath = file.label
    if (file.site || file.children.length || file.patchLines?.length) roots.push(file)
  }
  for (const group of roots) {
    group.added = 0
    group.removed = 0
    group.renameCount = 0
    for (const { site } of group.children ?? []) {
      if (site.renameLocation) group.renameCount++
      else if (site.side === 'L') group.removed += site.end - site.number + 1
      else {
        group.added += site.end - site.number + 1
        if (site.previous) group.removed++
      }
    }
    group.size = group.added + group.removed + group.renameCount
  }
  return roots.sort((a, b) => b.size - a.size || a.label.localeCompare(b.label))
}

export function changeContexts(diff, graph, displayedPaths) {
  const changedLines = new Map()
  const roots = changeTree(diff, graph, changedLines)
  let paths = [...changedLines.keys()]
  if (Array.isArray(displayedPaths)) {
    const displayed = new Set(displayedPaths)
    if (paths.every(path => displayed.has(path))) paths = displayedPaths
  }
  const fileOrder = new Map(paths.map((path, index) => [path, index]))
  const modulesByStem = new Map()
  const entries = roots.filter(root => !root.testPath).map(root => {
    const definition = graph.nodes.get(root.symbol)?.definitions.find(site => !site.prototypeKey && !isTestFile(site.path))
    const path = definition?.path ?? root.site?.path ?? root.children[0].site.path
    const parts = path.split('/')
    const name = parts.pop().replace(/\.[^.]+$/, '')
    const stem = name.toLowerCase()
    while (parts.length > 1 && /^(?:src|inc|include)$/.test(parts.at(-1))) parts.pop()
    const module = parts.join('/') || name || path
    const matchSource = /\.(?:h|hh|hpp|hxx)$/i.test(path)
    if (!matchSource) {
      if (!modulesByStem.has(stem)) modulesByStem.set(stem, new Set())
      modulesByStem.get(stem).add(module)
    }
    return { root, path, stem, matchSource, module }
  })

  const groups = new Map()
  const files = new Map()
  function moduleFor(key) {
    if (!groups.has(key)) {
      const parts = key.split('/')
      const label = /^(?:c|cpp|js|ts|java|kotlin|rust)$/.test(parts.at(-1)) ? parts.slice(-2).join('/') : parts.at(-1)
      groups.set(key, { path: key, label: label || 'Repository', children: [], files: [], testFiles: [], cases: new Set(), lines: new Set(), added: 0, removed: 0, renameCount: 0 })
    }
    return groups.get(key)
  }
  const countedRenames = new Set()
  for (const { root, path, stem, matchSource, module } of entries) {
    const matches = modulesByStem.get(stem)
    const key = matchSource && matches?.size === 1 ? matches.values().next().value : module
    const group = moduleFor(key)
    if (!files.has(path)) {
      const file = { path, label: path.split('/').at(-1), children: [], testFiles: [], cases: new Set(), lines: new Set(), size: 0, added: 0, removed: 0, renameCount: 0 }
      files.set(path, file)
      group.files.push(file)
    }
    const file = files.get(path)
    if (root.site) file.site = root.site
    else if (root.label === path && !root.symbol) file.children.push(...root.children)
    else file.children.push(root)
    file.size += root.size
    file.added += root.added
    file.removed += root.removed
    file.renameCount += root.renameCount
    group.children.push(root)
    group.added += root.added
    group.removed += root.removed
    for (const { site } of root.children ?? []) {
      if (!site.renameLocation || site.mixedRename) continue
      const line = site.path + ':' + site.number
      if (countedRenames.has(line)) continue
      countedRenames.add(line)
      group.renameCount++
    }
    group.size = group.added + group.removed + group.renameCount
  }
  const testFiles = roots.filter(root => root.testPath)
  attachTests(testFiles, graph, files, groups, moduleFor)
  const testByPath = new Map(testFiles.map(root => [root.testPath, root]))
  const testPathByLine = new Map()
  for (const test of testFiles) {
    for (const line of test.patchLines ?? []) testPathByLine.set(line, test.testPath)
  }
  const patch = diff.split(/\r?\n/)
  function lineChanges(paths, testLines) {
    const byFile = countTestLines(testLines)
    let added = 0, removed = 0, testsAdded = 0, testsRemoved = 0
    for (const path of paths) {
      const counts = changedLines.get(path)
      added += counts?.added ?? 0
      removed += counts?.removed ?? 0
      if (counts?.added || counts?.removed) byFile.set(path, counts.added + counts.removed)
    }
    for (const line of testLines) {
      if (patch[line]?.startsWith('+')) testsAdded++
      else if (patch[line]?.startsWith('-')) testsRemoved++
    }
    return { added: added + testsAdded, removed: removed + testsRemoved, testsAdded, testsRemoved, byFile }
  }
  function countTestLines(lines) {
    const counts = new Map()
    for (const line of lines) {
      const path = testPathByLine.get(line)
      counts.set(path, (counts.get(path) ?? 0) + 1)
    }
    return counts
  }
  for (const group of groups.values()) {
    const related = new Set(group.testFiles)
    for (const file of group.files) {
      file.testCount = file.cases.size
      file.testLines = file.lines.size
      file.testLinesByFile = countTestLines(file.lines)
      file.lineChanges = lineChanges([file.path], file.lines)
      const code = changedLines.get(file.path)
      const codeLines = (code?.added ?? 0) + (code?.removed ?? 0)
      file.codeLinesByFile = new Map(codeLines && sourceFile.test(file.path) ? [[file.path, codeLines]] : [])
      const sources = new Set(file.testFiles)
      for (const test of file.cases) {
        group.cases.add(test)
        const source = testByPath.get(test.path)
        if (source) sources.add(source)
      }
      file.relatedTests = [...sources]
      for (const source of sources) related.add(source)
      for (const line of file.lines) group.lines.add(line)
      delete file.cases
      delete file.lines
      const byLine = file.children.map(child => {
        const definition = graph.nodes.get(child.symbol)?.definitions.find(site => site.path === file.path && !site.prototypeKey)
        const sites = child.site ? [child.site] : child.children.map(entry => entry.site)
        const line = definition?.number ?? sites.reduce((first, site) =>
          site.path === file.path ? Math.min(first, site.number) : first, Infinity)
        return { child, line }
      })
      file.children = byLine.sort((a, b) => a.line - b.line).map(entry => entry.child)
    }
    group.files.sort((a, b) => b.size - a.size || a.path.localeCompare(b.path))
    const cFilesByStem = Map.groupBy(group.files.filter(file => /\.(?:c|h)$/i.test(file.label)),
      file => file.label.slice(0, -2))
    const pairs = new Map()
    for (const siblings of cFilesByStem.values()) {
      const sources = siblings.filter(file => /\.c$/i.test(file.label))
      const headers = siblings.filter(file => /\.h$/i.test(file.label))
      if (sources.length !== 1 || headers.length !== 1) continue
      const pair = [...sources, ...headers].sort((a, b) => fileOrder.get(a.path) - fileOrder.get(b.path))
      for (const file of pair) pairs.set(file, pair)
    }
    group.files = [...new Set(group.files.map(file => pairs.get(file) ?? file))].flat()
    group.testCount = group.cases.size
    group.testLines = group.lines.size
    group.relatedTests = [...related]
    group.testLinesByFile = countTestLines(group.lines)
    const codePaths = new Set(group.files.map(file => file.path))
    for (const root of group.children) {
      if (root.testPath) continue
      for (const { site } of root.children) if (!files.has(site.path) && !testByPath.has(site.path)) codePaths.add(site.path)
    }
    group.lineChanges = lineChanges(codePaths, group.lines)
    group.codeLinesByFile = new Map()
    for (const path of codePaths) {
      const code = changedLines.get(path)
      const count = (code?.added ?? 0) + (code?.removed ?? 0)
      if (count && sourceFile.test(path)) group.codeLinesByFile.set(path, count)
    }
    delete group.cases
    delete group.lines
    group.size ??= 0
    const paths = group.files.map(file => file.path)
    for (const root of group.children) if (root.testPath) paths.push(root.testPath)
    group.firstFile = paths.reduce((first, path) => Math.min(first, fileOrder.get(path) ?? Infinity), Infinity)
  }
  const contexts = [...groups.values()]
  for (const namesakes of Map.groupBy(contexts, group => group.label).values()) {
    if (namesakes.length > 1) for (const group of namesakes) group.label = group.path
  }
  return contexts.sort((a, b) => a.firstFile - b.firstFile)
}

function attachTests(testFiles, graph, files, groups, moduleFor) {
  const byStem = Map.groupBy(files.values(), file => file.label.replace(/\.[^.]+$/, '').toLowerCase())
  const byTestFile = Map.groupBy(graph.testCases, test => test.path)
  const oldCases = Map.groupBy(graph.before.testCases, test => test.path)
  const ownerModule = new Map([...groups.values()].flatMap(group => group.files.map(file => [file, group])))
  for (const root of testFiles) {
    const parts = root.testPath.split('/')
    const name = parts.pop().replace(/\.[^.]+$/, '')
    const stem = name.replace(/^(?:tests?|specs?)[._-]|[._-](?:tests?|specs?)$/gi, '').replace(/^Test(?=[A-Z])|(?:Tests?|Spec)$/, '')
    const matches = byStem.get(stem.toLowerCase()) ?? []
    const implementations = matches.filter(file => !/\.(?:h|hh|hpp|hxx)$/i.test(file.path))
    const named = implementations.length === 1 ? implementations[0] : matches.length === 1 ? matches[0] : undefined
    const tests = [...(byTestFile.get(root.testPath) ?? [])]
    const byName = Map.groupBy(tests, test => test.name)
    const byLine = new Map()
    for (const test of tests) for (const line of test.patchLines) byLine.set(line, test)
    const matched = new Set()
    for (const old of oldCases.get(root.oldPath) ?? []) {
      const shared = [...old.patchLines].map(line => byLine.get(line)).find(test => test && !matched.has(test))
      const surviving = shared ?? byName.get(old.name)?.find(test => !matched.has(test))
      if (surviving) {
        matched.add(surviving)
        for (const line of old.patchLines) surviving.patchLines.add(line)
      } else tests.push(old)
    }
    const unassigned = new Set(root.patchLines)
    const linkedFiles = new Set()
    const unlinkedCases = []
    for (const test of tests) {
      const targets = new Set()
      for (const target of test.targets.keys()) {
        const node = target.renamedTo ?? graph.nodes.get(target.id) ?? target
        const definitions = node.definitions.filter(site => !site.prototypeKey)
        const paths = new Set((definitions.length ? definitions : [...node.changes.values()]).map(site => site.path).filter(path => files.has(path)))
        if (paths.size === 1) targets.add(files.get([...paths][0]))
      }
      if (!targets.size && named) targets.add(named)
      if (!targets.size) unlinkedCases.push(test)
      for (const file of targets) {
        file.cases.add(test)
        linkedFiles.add(file)
        for (const line of test.patchLines) {
          file.lines.add(line)
          unassigned.delete(line)
        }
      }
    }
    const owner = named ?? (linkedFiles.size === 1 ? [...linkedFiles][0] : undefined)
    const testDirectory = parts.findIndex(isTestDirectory)
    const directory = (testDirectory > 0 ? parts.slice(0, testDirectory) : parts.filter(part => !isTestDirectory(part))).join('/')
    const group = ownerModule.get(owner ?? linkedFiles.values().next().value) ?? moduleFor(directory)
    const attachment = owner ?? group
    attachment.testFiles.push(root)
    group.children.push(root)
    root.testCount = tests.length
    root.testLines = root.patchLines?.length ?? 0
    for (const test of unlinkedCases) attachment.cases.add(test)
    for (const line of unassigned) attachment.lines.add(line)
  }
}
