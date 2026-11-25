function declarations(hunk, byLine, byMember) {
  if (!hunk.rows.some(row => /\benum\b/.test(row.code))) return
  let continuedDirective = false
  const masked = hunk.rows.map(({ code }) => {
    if (hunk.language !== 'c' || (!continuedDirective && !/^\s*#/.test(code))) return code
    continuedDirective = code.trimEnd().endsWith('\\')
    return ' '.repeat(code.length)
  }).join('\n')
  const source = hunk.rows.map(row => row.source).join('\n')
  const header = /\b(?:(typedef)\s+)?enum(?:\s+(class|struct))?(?:\s+([A-Za-z_]\w*))?(?:\s*:\s*[\w: \t]+)?\s*\{/g
  let firstRow = 0
  for (const match of masked.matchAll(header)) {
    const start = match.index + match[0].length
    const members = []
    let depth = 0, from = start, end = start
    let constants = true
    for (; end < masked.length; end++) {
      const token = masked[end]
      if (!depth && (token === ',' || token === '}' || token === ';')) {
        if (constants) {
          const part = masked.slice(from, end)
          const id = /^\s*(?:#\[[^\]]*\]\s*)*([A-Za-z_$][\w$]*)/.exec(part)
          if (id) {
            const offset = from + id[0].length - id[1].length
            const value = source.slice(offset + id[1].length, end).trim()
            members.push({ name: id[1], value: value.startsWith('=') ? value : '', offset, uses: [] })
          }
        }
        if (token === '}') break
        if (token === ';') constants = false
        from = end + 1
      } else if ('({['.includes(token)) depth++
      else if (')}]'.includes(token)) depth--
    }
    if (end === masked.length) continue
    const alias = match[1] && /^\s*([A-Za-z_]\w*)\s*;/.exec(masked.slice(end + 1))
    const names = [match[3], alias?.[1]].filter(Boolean)
    const entry = { name: names.at(-1) ?? 'enum', members }
    const last = end + (alias ? alias[0].length : 0)
    while (hunk.rows[firstRow + 1]?.offset <= match.index) firstRow++
    if (!byLine.has(hunk.path)) byLine.set(hunk.path, new Map())
    for (let i = firstRow; i < hunk.rows.length && hunk.rows[i].offset <= last; i++) {
      byLine.get(hunk.path).set(hunk.rows[i].number, entry)
    }
    for (const member of members) {
      hunk.declared.add(member.offset)
      const key = hunk.language + ':' + member.name
      if (!byMember.has(key)) byMember.set(key, [])
      byMember.get(key).push({ member, names, bare: hunk.language === 'c' && !match[2] })
    }
  }
}

export function enumIndex(hunks) {
  const byLine = new Map(), byMember = new Map()
  for (const hunk of hunks) {
    let offset = 0
    hunk.declared = new Set()
    for (const row of hunk.rows) {
      row.offset = offset
      offset += row.code.length + 1
    }
    declarations(hunk, byLine, byMember)
  }
  if (!byMember.size) return byLine
  for (const hunk of hunks) {
    let previous, qualifier
    for (const row of hunk.rows) {
      const uses = new Map()
      for (const token of row.code.matchAll(/[A-Za-z_$][\w$]*|::|->|[^\s]/g)) {
        const word = token[0]
        const candidates = byMember.get(hunk.language + ':' + word)
        if (candidates && !hunk.declared.has(row.offset + token.index)) {
          const qualified = previous === '::' || previous === '.' || previous === '->'
          const matches = candidates.filter(candidate => qualified
            ? previous !== '->' && candidate.names.includes(qualifier)
            : candidate.bare)
          if (matches.length === 1) {
            const member = matches[0].member
            if (!uses.has(member)) {
              const highlights = []
              uses.set(member, highlights)
              member.uses.push({ path: hunk.path, number: row.number, end: row.number, added: row.added,
                preview: [(row.added ? '+' : ' ') + row.source], highlights })
            }
            const start = token.index + Number(row.added)
            uses.get(member).push([start, start + word.length])
          }
        }
        qualifier = previous
        previous = word
      }
    }
  }
  return byLine
}
