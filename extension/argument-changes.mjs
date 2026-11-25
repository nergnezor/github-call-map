import { isTestFile } from './test-cases.mjs'

export function argumentChanges(removed, added) {
  // Limit signature generation for generated calls with hundreds of arguments.
  const incomplete = call => !call.args || call.args.length > 64
  const block = call => JSON.stringify([call.block, call.qualifier, (call.site.owner?.renamedTo ?? call.site.owner)?.id,
    (call.site.target.renamedTo ?? call.site.target).id])
  const oldBlocks = Map.groupBy(removed, block)
  const patterns = new Map()
  for (const [key, next] of Map.groupBy(added, block)) {
    const previous = oldBlocks.get(key)
    if (previous?.length !== next.length || previous.some(incomplete) || next.some(incomplete)) continue
    const old = Map.groupBy(previous, call => JSON.stringify(call.args))
    const edited = next.filter(call => !old.get(JSON.stringify(call.args))?.pop())
    const replacements = new Map()
    for (const calls of old.values()) {
      if (!calls.length) continue
      const args = calls[0].args
      args.forEach((_, index) => {
        const signature = JSON.stringify([index, args.toSpliced(index, 1)])
        replacements.set(signature, replacements.has(signature) ? null : calls)
      })
    }
    const matches = []
    for (const call of edited) {
      const candidates = []
      call.args.forEach((value, index) => {
        const rest = call.args.toSpliced(index, 1)
        const insertion = old.get(JSON.stringify(rest))
        if (insertion?.length) candidates.push({ source: insertion, index, value })
        const replacement = replacements.get(JSON.stringify([index, rest]))
        if (replacement) candidates.push({ source: replacement, index, value, from: replacement[0].args[index] })
      })
      if (candidates.length === 1) matches.push({ ...candidates[0], call })
    }
    for (const [source, pairs] of Map.groupBy(matches, match => match.source)) {
      if (pairs.length !== source.length) continue
      for (const { call, index, value, from } of pairs) {
        const { site, qualifier } = call
        const test = isTestFile(site.path)
        const id = JSON.stringify([site.target.id, qualifier, call.args.length, index, from, test])
        if (!patterns.has(id)) patterns.set(id, { name: qualifier + site.target.name, position: index + 1, from, test, values: new Map() })
        const values = patterns.get(id).values
        if (!values.has(value)) values.set(value, [])
        values.get(value).push(site)
      }
    }
  }
  return [...patterns.values()].filter(pattern => pattern.values.size > 1).map(({ values, ...pattern }) => {
    const variants = [...values].map(([value, sites]) => ({ value, sites })).sort((a,b) => b.sites.length - a.sites.length)
    const count = variants.reduce((total, v) => total + v.sites.length, 0)
    for (const variant of variants) variant.exception = variants[0].sites.length > count / 2 && variant !== variants[0]
    return { ...pattern, variants }
  })
}
