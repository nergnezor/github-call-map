import { headerPath } from './changes.mjs'
import { isTestDirectory } from './test-cases.mjs'

export function reviewSnapshot(diff, contexts) {
  const files = new Map()
  const groups = contexts.map(context => ({ key: context.path, label: context.label, files: [] }))
  contexts.forEach((context, i) => {
    const ranges = new Map()
    function include(site, side, number, end) {
      if (!files.has(site.path)) files.set(site.path, { L: new Map(), R: new Map(), metadata: new Set() })
      if (!ranges.has(site.path)) {
        const file = { path: site.path, lines: [], positions: [] }
        ranges.set(site.path, file)
        groups[i].files.push(file)
      }
      const range = ranges.get(site.path)
      const file = files.get(site.path)
      if (!number) file.metadata.add(range)
      else for (let n = number; n <= end; n++) {
        const rows = file[side]
        if (!rows.has(n)) rows.set(n, new Set())
        rows.get(n).add(range)
      }
    }
    for (const child of context.children) {
      for (const { site } of child.site ? [child] : child.children) {
        include(site, site.side ?? 'R', site.number, site.end)
        if (site.previous) include(site.previous, 'L', site.previous.number, site.previous.end)
      }
    }
  })
  let file, left, right
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      file = files.get(headerPath(line))
      left = undefined
      continue
    }
    if (!file) continue
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/)
    if (hunk) {
      left = Number(hunk[1])
      right = Number(hunk[2])
    } else if (left === undefined) {
      if (line) for (const range of file.metadata) range.lines.push(line)
    } else if (line[0] === ' ') {
      left++
      right++
    } else if (line[0] === '-' || line[0] === '+') {
      const position = left
      const rows = line[0] === '-' ? file.L.get(left++) : file.R.get(right++)
      for (const range of rows ?? []) {
        range.lines.push(line)
        range.positions.push(position)
      }
    }
  }
  return groups
}

export function sinceReview(before, after) {
  const old = new Map(before.map(group => [group.key, group]))
  const next = new Map(after.map(group => [group.key, group]))
  // Older review points stored all test files in one group.
  const legacy = old.get('Tests')
  if (legacy && !next.has('Tests')) {
    old.delete('Tests')
    const owners = new Map(after.flatMap(group => group.files.map(file => [file.path, group.key])))
    for (const file of legacy.files) {
      const key = owners.get(file.path) ?? file.path.split('/').slice(0, -1).filter(part => !isTestDirectory(part)).join('/')
      const group = old.get(key) ?? { key, label: next.get(key)?.label ?? (key || 'Repository'), files: [] }
      old.set(key, { ...group, files: [...group.files, file] })
    }
  }
  const changed = []
  for (const key of new Set([...next.keys(), ...old.keys()])) {
    const previous = new Map(old.get(key)?.files.map(file => [file.path, file]))
    const current = new Map(next.get(key)?.files.map(file => [file.path, file]))
    const files = []
    for (const path of new Set([...current.keys(), ...previous.keys()])) {
      const oldFile = previous.get(path), newFile = current.get(path)
      const a = oldFile?.lines ?? [], b = newFile?.lines ?? []
      const equal = (i, j) => a[i] === b[j] && oldFile.positions?.[i] === newFile.positions?.[j]
      let start = 0, end = 0
      const limit = Math.min(a.length, b.length)
      while (start < limit && equal(start, start)) start++
      if (start === a.length && start === b.length && previous.has(path) === current.has(path)) continue
      while (end < limit - start && equal(a.length - end - 1, b.length - end - 1)) end++
      files.push({ path, oldLine: oldFile?.positions?.[start], newBaseLine: newFile?.positions?.[start], before: a.slice(start, a.length - end), after: b.slice(start, b.length - end) })
    }
    if (files.length) changed.push({ key, label: (next.get(key) ?? old.get(key)).label, files })
  }
  return changed
}
