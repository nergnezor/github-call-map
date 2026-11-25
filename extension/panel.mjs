import { reviewSnapshot } from './review.mjs'
import { changeContexts } from './changes.mjs'
import { buildGraph, fileHash, lineHash, pullRequest, selectionAt } from './graph.mjs'

const changes = document.querySelector('#changes')
const tree = changes.querySelector('ul')
const status = document.querySelector('#status')
const main = document.querySelector('main')
const select = document.querySelector('#symbol')
const enumDetail = document.querySelector('#enum-detail')
const callers = document.querySelector('#callers')
const incoming = document.querySelector('#incoming')
const reload = document.querySelector('#reload')
const back = document.querySelector('#back')
const variants = document.querySelector('#variants')
const tabId = await chrome.runtime.sendMessage('host-tab')
document.querySelector('#close').onclick = () => chrome.runtime.sendMessage('close-dock')
let current, request
let version = 0
let latestReveal = 0
document.querySelector('#skip-details').onclick = () => document.querySelector('#details').focus()

function element(tag, text, className) {
  const el = document.createElement(tag)
  el.textContent = text
  if (className) el.className = className
  return el
}

function isFullDiff(url) {
  const location = new URL(url)
  return /\/(?:changes|files)\/?$/.test(location.pathname)
    && [...location.searchParams.keys()].every(key => key === 'w' || key === 'diff')
}

function rememberLocation() {
  if (!current) return
  const symbol = current.symbol
  const node = current.analysis?.nodes.get(symbol)
  const site = current.site ?? node?.definitions[0] ?? node?.changes.values().next().value ?? node?.incoming[0]
  current.history.push({ site, symbol, summary: current.selectedSummary,
    open: [...tree.querySelectorAll('details[open]')], scroll: tree.scrollTop })
  back.disabled = false
  current.port?.postMessage?.({ canGoBack: true })
}

function jumpTo(site, preview = false) {
  if (site && (site.path !== current.site?.path || site.number !== current.site?.number || (site.side ?? 'R') !== (current.site?.side ?? 'R'))) rememberLocation()
  if (site) {
    const range = changeAt(site)
    const item = current.analysis.nodes.get(range?.symbol) ?? (site.side !== 'L' && selectionAt(current.analysis, '', site.path, site.number))
    showSymbol(item, range?.control ?? current.testFiles.get(site.path) ?? current.summaries.get(item?.id) ?? current.files.get(site.path))
  }
  return revealSite(site, preview)
}

async function goBack() {
  const entry = current?.history.pop()
  if (!entry) return
  back.disabled = !current.history.length
  current.port?.postMessage?.({ canGoBack: !back.disabled })
  if (entry.symbol && current.analysis.nodes.has(entry.symbol)) {
    select.value = entry.symbol
    render(entry.summary)
  } else {
    hideGraph()
    markSummary(entry.summary)
  }
  for (const branch of tree.querySelectorAll('details[open]')) if (!entry.open.includes(branch)) branch.open = false
  for (const branch of entry.open) {
    if (branch.isConnected) branch.open = true
  }
  tree.scrollTop = entry.scroll
  current.matches = []
  if (entry.site) await revealSite(entry.site, true)
}

function backKey(event) {
  if (back.disabled || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey || event.key !== 'ArrowLeft') return
  event.preventDefault()
  event.stopPropagation()
  goBack()
}
back.onclick = goBack
document.addEventListener('keydown', backKey, true)

async function revealSite(site, preview = false) {
  const revision = ++latestReveal
  if (!site) return
  const snapshot = current
  showActiveChange(site)
  const hash = site.number ? await lineHash(site.path, site.number, site.side, site.end) : await fileHash(site.path)
  try {
    const tab = await chrome.tabs.get(tabId)
    if (revision !== latestReveal || current !== snapshot || baseUrl(tab.url) !== snapshot.base) return
    const page = tab.url.split('#')[0]
    const full = isFullDiff(page)
    if (full && (preview || tab.url === page + hash)) {
      const shown = await chrome.tabs.sendMessage(tab.id, {
        type: 'reveal', page, hash,
      }, { frameId: 0 }).catch(() => false)
      if (shown || revision !== latestReveal || current !== snapshot) return
      const latest = await chrome.tabs.get(tabId)
      if (revision !== latestReveal || current !== snapshot || latest.url !== tab.url) return
    }
    if (preview) snapshot.hash = hash
    await chrome.tabs.update(tab.id, { url: (full ? page : snapshot.base + '/changes') + hash })
  } catch (error) {
    if (error?.message !== 'Extension context invalidated.') throw error
  }
}

function followSymbol(id, fallback) {
  rememberLocation()
  select.value = id
  render()
  const node = current.analysis.nodes.get(id)
  const definition = node.definitions.find(site => !site.prototypeKey) ?? node.definitions[0]
  return revealSite(definition ?? node.changes.values().next().value ?? fallback ?? node.incoming[0], true)
}

const rightPane = document.querySelector('#details')
const fileGroups = document.querySelector('#file-groups')
let detailsPending = false
function updateDetails() {
  if (detailsPending) return
  detailsPending = true
  queueMicrotask(() => {
    detailsPending = false
    renderFiles()
  })
}

function renderFiles() {
  const files = new Map()
  function file(path) {
    if (!files.has(path)) {
      const section = element('section', '', 'detail-file')
      section.dataset.path = path
      files.set(path, section)
    }
    return files.get(path)
  }
  const item = current?.analysis?.nodes.get(current.symbol)
  const entry = current?.enumDetail
  main.hidden = !item || Boolean(entry || current.variable)
  enumDetail.hidden = !entry
  if (entry) {
    enumDetail.textContent = entry.name
    const declaration = current.site.path
    file(declaration)
    for (const member of entry.members) {
      const uses = Map.groupBy(member.uses, site => site.path)
      if (!uses.has(declaration)) uses.set(declaration, [])
      for (const [path, sites] of uses) {
        const row = element('div', '', 'enum-member')
        row.append(element('code', path === declaration && member.value ? member.name + ' ' + member.value : member.name))
        for (const site of sites) row.append(locationButton(site, '', true))
        file(path).append(row)
      }
    }
  } else {
    const active = current?.activeLine
    if (active) {
      const button = locationButton(active, '', true)
      button.classList.add('active-change')
      button.setAttribute('aria-current', 'location')
      file(active.path).append(button)
    }
    if (current?.variable) {
      for (const site of current.variable.uses) file(site.path).append(locationButton(site, '', true))
      if (!current.variable.uses.length) file(active.path).append(element('small', 'No uses in diff'))
    } else if (item) {
      const shown = new Set()
      if (active && active.side !== 'L') shown.add(active.path + ':' + active.number)
      for (const site of [...item.definitions, ...item.changes.values()]) {
        const key = site.path + ':' + site.number
        if (shown.has(key)) continue
        shown.add(key)
        file(site.path).append(locationButton(site, '', true))
      }
      for (const [path, sites] of Map.groupBy(item.outgoing.filter(site => site.added), site => site.path)) {
        const lane = element('div', '', 'outgoing lane')
        lane.setAttribute('aria-label', 'Added calls')
        group(lane, sites, 'target')
        file(path).append(lane)
      }
      for (const test of item.tests ?? []) file(test.path).append(testButton(test, 'linked-test', test.checks))
    }
    for (const match of current?.matches ?? []) file(match.path).append(testButton(match, 'assertion', [match.code]))
  }
  addFileHeadings(files)
  const focused = document.activeElement
  const restoreFocus = fileGroups.contains(focused)
  fileGroups.replaceChildren(...files.values())
  if (restoreFocus) {
    const sameLocation = [...fileGroups.querySelectorAll('button')].find(button => button.title === focused.title && button.className === focused.className)
    const target = sameLocation ?? rightPane
    target.focus({ preventScroll: true })
  }
}

function addFileHeadings(files) {
  const basename = path => path.split('/').at(-1)
  const byName = Map.groupBy(files.keys(), basename)
  for (const [path, section] of files) {
    const name = basename(path)
    const heading = element('h3', byName.get(name).length === 1 ? name : path)
    heading.title = path
    section.prepend(heading)
  }
}

function changeLabel(site) {
  if (site.side !== 'L') {
    const enums = current.analysis.enums.get(site.path)
    const declaration = enums?.get(site.number)
    if (declaration && enums.get(site.end) === declaration) return declaration.name
    const variable = current.analysis.lines.get(site.path)?.get(site.number)?.variable
    if (variable && site.number === site.end) return variable.name
  }
  const lines = (site.preview ?? []).map(line => line.slice(1).trim()).filter(Boolean)
  if (!lines.length) return ''
  const words = lines.map(line => line.split(/\s+/))
  const first = words[0]
  const different = first.findIndex((word, index) => words.some(line => line[index] !== word))
  if (different > 0) return first.slice(0, different).join(' ')
  return lines[0] + (lines.length > 1 && different === 0 ? ' …' : '')
}

function appendLineCounts(label, added, removed) {
  if (added) label.append(' ', element('span', '+' + added, 'added-lines'))
  if (removed) label.append(' ', element('span', '−' + removed, 'removed-lines'))
}

function locationButton(site, labelOnly = '', grouped = false) {
  const file = site.path.split('/').at(-1)
  const range = site.end > site.number ? site.number + '–' + site.end : site.number
  const type = site.previous ? 'changed' : site.added === false || site.renameLocation ? '' : site.side === 'L' ? 'removed' : site.added || site.side === 'R' ? 'added' : ''
  const button = element('button', '', 'location ' + type)
  button.dataset.path = site.path
  button.classList.toggle('viewed', current.viewed?.get(site.path) === true)
  const row = site.side !== 'L' ? current.analysis.lines.get(site.path)?.get(site.number) : undefined
  const preview = grouped ? site.preview : site.preview?.slice(0, 4)
  const source = preview?.join('\n') ?? row?.source
  const edit = site.preview ? site.inline : row?.inline
  if (!labelOnly && edit) {
    const code = element('code', edit.prefix, 'snippet inline-edit')
    if (edit.removed) code.append(element('del', edit.removed))
    if (edit.added) code.append(element('ins', edit.added))
    code.append(edit.suffix)
    button.append(code)
  } else if (!labelOnly && source !== undefined) {
    const omitted = site.preview ? site.end - site.number + 1 - preview.length : 0
    const snippet = site.added === false ? source.slice(1) : source
    const code = element('code', '', 'snippet')
    let offset = 0
    for (const [start, end] of site.highlights ?? []) {
      code.append(snippet.slice(offset, start), element('mark', snippet.slice(start, end)))
      offset = end
    }
    code.append(snippet.slice(offset) + (omitted ? '\n… +' + omitted : ''))
    button.append(code)
  }
  const reference = labelOnly === 'old' ? '−' + range : grouped || labelOnly ? String(range ?? '') : range ? file + ':' + range : file
  const name = labelOnly === 'caller' ? site.owner?.name : labelOnly === 'line' ? changeLabel(site) : ''
  const lineLabel = element('span', name ? String(site.number) : reference, 'reference')
  button.append(lineLabel)
  if (name) {
    if (labelOnly === 'line') {
      const length = site.end - site.number + 1
      appendLineCounts(lineLabel, site.side === 'L' ? 0 : length, site.side === 'L' ? length : Number(Boolean(site.previous)))
    }
    button.classList.add('named-range')
    button.append(element('span', name, 'bubble-name'))
  }
  button.title = site.path + (range ? ':' + range : '') + (type ? ' · ' + type : '')
  button.setAttribute('aria-description', button.title)
  if (labelOnly || source === undefined) button.setAttribute('aria-label', 'Open ' + (name ? name + ', ' : '') + button.title)
  button.onclick = () => jumpTo(site)
  return button
}

function changeAt(site) {
  return current.ranges.get(site.path)?.find(({ site: range }) =>
    (range.side ?? 'R') === (site.side ?? 'R') && range.number <= site.number && site.number <= range.end)
}

function showEnum(entry) {
  if (entry === current.enumDetail) return
  current.enumDetail = entry
  updateDetails()
}

function showActiveChange(site, range = changeAt(site)) {
  const previous = current.site
  current.site = site
  current.variable = site.side !== 'L' && current.analysis.lines.get(site.path)?.get(site.number)?.variable
  const entry = site.side !== 'L' ? current.analysis.enums.get(site.path)?.get(site.number) : undefined
  showEnum(entry)
  if (entry) return
  if (previous && previous.path === site.path && previous.number === site.number && (previous.side ?? 'R') === (site.side ?? 'R')) return
  current.matches = []
  const line = range?.site.preview?.[site.number - range.site.number]
  const active = {
    ...site, end: site.number, preview: line === undefined ? undefined : [line],
    inline: range?.site.inline, previous: range?.site.previous, renameLocation: range?.site.renameLocation,
    added: range ? site.added : false,
  }
  current.activeLine = active
  updateDetails()
  if (site.side !== 'L') showAssertions(site.path, site.number)
}

function testButton(test, className, checks) {
  const button = element('button', test.name, 'test-case ' + className)
  button.dataset.path = test.path
  button.title = test.path + ':' + test.number
  button.setAttribute('aria-description', button.title)
  button.append(element('span', String(test.number), 'reference'))
  for (const check of checks) button.append(element('code', check, 'snippet'))
  button.onclick = () => jumpTo(test, true)
  return button
}

function showRename(control, symbol) {
  if (!symbol?.renamedFrom) return
  const names = element('span', '', 'rename')
  names.append(element('del', symbol.renamedFrom, 'former-name'), element('span', symbol.name, 'new-name'))
  control.replaceChildren(names)
  control.setAttribute('aria-label', 'Renamed from ' + symbol.renamedFrom + ' to ' + symbol.name)
}

function group(lane, sites, direction) {
  lane.replaceChildren()
  const grouped = Map.groupBy(sites, site => site[direction])
  for (const [neighbor, matches] of grouped) {
    const entry = element('div', '', 'entry')
    if (neighbor) {
      const button = element('button', neighbor.name, 'name')
      showRename(button, neighbor)
      button.title = 'Follow ' + neighbor.name
      button.onclick = () => {
        followSymbol(neighbor.id, matches[0])
        select.focus({ preventScroll: true })
      }
      entry.append(button)
    } else {
      const unknown = element('span', '?')
      unknown.title = 'Enclosing function unknown'
      unknown.setAttribute('aria-label', unknown.title)
      entry.append(unknown)
    }
    for (const site of matches) entry.append(locationButton(site, '', true))
    lane.append(entry)
  }
}

function markSummary(summary) {
  current.selectedSummary?.removeAttribute('aria-current')
  current.selectedSummary = summary
  summary?.setAttribute('aria-current', 'true')
}

function hideGraph() {
  updateDetails()
  main.hidden = callers.hidden = true
  current.symbol = undefined
}

function showSymbol(item, summary) {
  if (item && current.symbol !== item.id) {
    select.value = item.id
    render(summary)
  } else {
    if (!item) hideGraph()
    if (current.selectedSummary !== summary) markSummary(summary)
  }
}

function render(summary) {
  updateDetails()
  main.hidden = false
  const item = current.analysis.nodes.get(select.value)
  current.symbol = item.id
  const former = document.querySelector('#former-symbol')
  former.hidden = !item.renamedFrom
  former.textContent = item.renamedFrom ?? ''
  select.setAttribute('aria-label', item.renamedFrom ? 'Function renamed from ' + item.renamedFrom : 'Function or call')
  markSummary(summary ?? current.summaries.get(item.id))
  const files = new Map()
  for (const [path, sites] of Map.groupBy(item.incoming, site => site.path)) {
    const section = element('section', '', 'caller-file entry')
    for (const site of sites) section.append(locationButton(site, 'caller'))
    files.set(path, section)
  }
  addFileHeadings(files)
  incoming.replaceChildren(...files.values())
  callers.hidden = !item.incoming.length
}

function showVariants(patterns) {
  const list = variants.querySelector('div')
  list.replaceChildren()
  variants.hidden = !patterns.length
  for (const pattern of patterns) {
    const group = element('div', '', 'argument-group')
    const origin = pattern.from === undefined ? 'new argument ' : 'argument '
    group.append(element('strong', pattern.name + ' · ' + origin + pattern.position + (pattern.test ? ' · Tests' : '')))
    for (const { value, sites, exception } of pattern.variants) {
      const label = sites.length + ' × ' + value
      const control = element(sites.length === 1 ? 'button' : 'summary', label, exception ? 'minority' : '')
      control.title = (exception ? 'Less common · ' : '') + (pattern.from === undefined ? value : pattern.from + ' → ' + value)
      if (exception) control.setAttribute('aria-label', 'Less common: ' + label)
      if (sites.length === 1) {
        control.onclick = () => jumpTo(sites[0], true)
        group.append(control)
      } else {
        const locations = document.createElement('details')
        locations.append(control)
        for (const site of sites) locations.append(locationButton(site))
        group.append(locations)
      }
    }
    list.append(group)
  }
}

function showAssertions(path, number, clickedField) {
  const row = current.analysis.lines.get(path)?.get(number)
  if (!row?.changedCode || row.renameContext || current.testFiles.has(path)) return false
  const matches = new Map()
  for (const field of row.changedCode.matchAll(/(?:\.|->|::)\s*([a-zA-Z_$][\w$]*)|\b([a-zA-Z_$][\w$]*)\s*:(?!:)/g)) {
    const name = field[1] ?? field[2]
    if (clickedField && name !== clickedField) continue
    for (const match of current.analysis.assertions.get(row.language + ':' + name) ?? []) {
      matches.set(match.path + ':' + match.number, match)
    }
  }
  if (!matches.size) return false
  current.matches = [...matches.values()]
  updateDetails()
  if (clickedField && matches.size === 1) jumpTo(current.matches[0], true)
  return true
}

async function readDiff(base, signal) {
  const response = await fetch(base + '.diff', { credentials: 'include', cache: 'no-store', signal })
  if (!response.ok) throw new Error('GitHub returned HTTP ' + response.status + '.')
  const diff = await response.text()
  if (diff.trim() && !diff.startsWith('diff --git ')) throw new Error('GitHub did not return a diff. Check that you can open this PR.')
  return diff
}

function updateViewedProgress(indicator, lines, states) {
  let total = 0, viewed = 0, unknown = 0
  for (const [path, count] of lines) {
    total += count
    if (!states.has(path)) unknown += count
    else if (states.get(path)) viewed += count
  }
  const percent = 100 * viewed / total
  indicator.style.setProperty('--viewed', percent + '%')
  indicator.textContent = unknown === total ? 'Viewed —' : (unknown ? '≥' : '') + Math.floor(percent) + '% Viewed'
  return viewed + ' of ' + total + ' lines viewed' + (unknown ? ', Viewed status unavailable for ' + unknown : '')
}

function showViewed(entries) {
  const states = new Map()
  for (const [key, viewed] of entries) if (key.startsWith('path:')) states.set(key.slice(5), viewed)
  for (const [key, viewed] of entries) if (current.paths.has(key)) states.set(current.paths.get(key), viewed)
  current.viewed = states
  for (const { control, indicator, lines, description, path } of current.reviewControls) {
    const descriptions = [description]
    if (path && states.has(path)) descriptions.push(states.get(path) ? 'Viewed' : 'Unviewed')
    if (indicator) descriptions.push(updateViewedProgress(indicator, lines, states))
    control.setAttribute('aria-description', descriptions.join(', '))
  }
  for (const button of document.querySelectorAll('.location[data-path]')) button.classList.toggle('viewed', states.get(button.dataset.path) === true)
}

function testAmount(item) {
  return item.testCount + (item.testCount === 1 ? ' test' : ' tests') + ' · ' + item.testLines + (item.testLines === 1 ? ' test line' : ' test lines')
}

function visibleTreeEntries(entries) {
  return entries.flatMap(entry => {
    const site = entry.site
    if (site?.side !== 'R' || !site.preview?.some(line => /^\+\s*$/.test(line))) return [entry]
    const ranges = []
    let range
    for (const [offset, line] of site.preview.entries()) {
      if (/^\+\s*$/.test(line)) {
        range = undefined
        continue
      }
      const number = site.number + offset
      if (!range) {
        range = { ...site, number, preview: [] }
        ranges.push({ ...entry, site: range })
      }
      range.end = number
      range.preview.push(line)
    }
    return ranges
  })
}

function showChanges(roots) {
  current.ranges = new Map()
  current.summaries = new Map()
  current.testFiles = new Map()
  current.files = new Map()
  current.reviewControls = []
  const pending = roots.map(item => ({ item, list: tree }))
  for (const { item, list, path } of pending) {
    const row = document.createElement('li')
    list.append(row)
    if (item.size === undefined) {
      const button = locationButton(item.site, 'line')
      button.onfocus = () => jumpTo(item.site, true)
      row.append(button)
      if (item.site.previous) {
        const previous = locationButton(item.site.previous, 'old')
        previous.onfocus = () => jumpTo(item.site.previous, true)
        row.append(previous)
      }
      continue
    }

    const context = list === tree
    row.className = context ? 'context' : 'change'
    const testOnly = context && !item.files.length
    const firstTest = testOnly && item.testFiles[0]
    const entries = visibleTreeEntries(item.files ?? item.children)
    const bubble = context || Boolean(item.path)
    const sites = bubble ? [] : entries.map(entry => entry.site).filter(site => site.path === path)
    const first = sites.find(site => site.side !== 'L') ?? sites[0]
    const sameSide = sites.filter(site => (site.side ?? 'R') === (first?.side ?? 'R'))
    const functionRange = first && { path: first.path, side: first.side,
      number: Math.min(...sameSide.map(site => site.number)),
      end: Math.max(...sameSide.map(site => site.end)) }
    const location = functionRange ?? item.site ?? (firstTest && (firstTest.children[0]?.site ?? firstTest.site ?? { path: firstTest.testPath }))
    if (!bubble && !location) {
      row.remove()
      continue
    }
    const control = element(location ? 'button' : 'summary', '', bubble ? 'bubble' : 'tree-entry')
    const label = element('span', context || item.symbol ? item.label : item.label.split('/').at(-1), 'bubble-name')
    const start = functionRange?.number
    const size = element('span', String(start ?? item.size), 'group-size')
    if (start !== undefined) appendLineCounts(size, item.added, item.removed)
    const description = [item.added + ' added', item.removed + ' removed']
    if (item.renameCount) description.push(item.renameCount + ' rename locations')
    size.hidden = bubble
    size.title = description.join(', ')
    control.title = (item.path ?? item.label) + ' · ' + size.title
    control.setAttribute('aria-description', size.title)
    showRename(label, current.analysis.nodes.get(item.symbol))
    control.setAttribute('aria-label', label.getAttribute('aria-label') ?? (item.label + ', ' + item.size + ' changes'))
    if (start !== undefined) control.setAttribute('aria-label', control.getAttribute('aria-label') + ', starts at line ' + start)
    control.append(size, label)
    if (item.testCount || item.testLines) {
      const count = testAmount(item)
      const indicator = element('span', count, 'test-count')
      indicator.hidden = true
      description.push(count)
      indicator.title = item.relatedTests.map(test => test.testPath + ' · ' + testAmount(test)).join('\n')
      control.append(indicator)
      control.setAttribute('aria-label', control.getAttribute('aria-label') + ', ' + count)
    }
    let indicator
    if (bubble) {
      const { added, removed, testsAdded, testsRemoved, byFile } = item.lineChanges
      const singleFile = context && item.files.length === 1 ? item.files[0].lineChanges.byFile : undefined
      const duplicatesFile = singleFile?.size === byFile.size &&
        [...byFile].every(([path, count]) => singleFile.get(path) === count)
      const scale = Math.max(added, removed)
      if (scale && !duplicatesFile) {
        const bar = element('span', '', 'change-progress')
        bar.setAttribute('aria-hidden', 'true')
        for (const [sign, total, tests, direction] of [['−', removed, testsRemoved, 'removed'], ['+', added, testsAdded, 'added']]) {
          const half = element('span', total ? sign + total : '', direction)
          half.style.setProperty('--total', (100 * total / scale) + '%')
          half.style.setProperty('--tests', (100 * tests / scale) + '%')
          bar.append(half)
        }
        indicator = element('span', '', 'viewed-progress')
        bar.append(indicator)
        control.append(bar)
        description.push(removed + ' removed, including ' + testsRemoved + ' test lines',
          added + ' added, including ' + testsAdded + ' test lines')
      }
    }
    current.reviewControls.push({ control, indicator, lines: item.lineChanges?.byFile, description: description.join(', '), path: context ? undefined : item.path })
    for (const member of [...(context ? [] : [item]), ...(item.testFiles ?? [])]) {
      if (member.testPath) current.testFiles.set(member.testPath, control)
      for (const { site } of member.children ?? []) {
        if (!site?.number) continue
        if (!current.ranges.has(site.path)) current.ranges.set(site.path, [])
        const ranges = current.ranges.get(site.path)
        ranges.push({ site, control, symbol: member.symbol })
        if (site.previous) ranges.push({ site: site.previous, control, symbol: member.symbol })
      }
    }
    if (!context && item.path) current.files.set(item.path, control)
    if (item.symbol) current.summaries.set(item.symbol, control)
    if (location) {
      control.onclick = () => jumpTo(location)
      control.onfocus = () => jumpTo(location, true)
      row.append(control)
      continue
    }
    if (!context) control.onfocus = () => {
      rememberLocation()
      hideGraph()
      const first = entries.find(child => child.site?.renameLocation) ?? entries.find(child => child.site?.side === 'R') ?? entries[0]
      if (first?.site) revealSite(first.site, true)
      else if (item.path) revealSite({ path: item.path }, true)
    }
    const branch = document.createElement('details')
    const children = document.createElement('ul')
    if (context) {
      branch.open = item === roots[0]
    }
    branch.append(control, children)
    row.append(branch)
    for (const child of entries) pending.push({ item: child, list: children, path: item.path })
  }
  changes.hidden = !roots.length
}

function closeOtherBranches(branch) {
  for (const open of tree.querySelectorAll('details[open]')) {
    if (!branch || !open.contains(branch)) open.open = false
  }
}

function openBranch(branch) {
  closeOtherBranches(branch)
  for (let ancestor = branch; ancestor; ancestor = ancestor.parentElement.closest('details')) ancestor.open = true
}

tree.addEventListener('click', event => {
  const summary = event.target.closest('summary')
  if (!summary) return
  closeOtherBranches(summary.parentElement)
})

tree.addEventListener('keydown', event => {
  const row = event.target
  if (!row.matches('summary, button') || !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return
  event.preventDefault()
  const branch = row.matches('summary') ? row.parentElement : null
  if (event.key === 'ArrowLeft') {
    if (branch?.open) openBranch(branch.parentElement.closest('details'))
    else row.closest('ul').closest('details')?.querySelector('summary').focus()
  } else if (event.key === 'ArrowRight') {
    if (branch && !branch.open) openBranch(branch)
    else branch?.querySelector(':scope > ul > li:first-child :is(summary, button)')?.focus()
  } else {
    const visible = [...tree.querySelectorAll('summary, button')].filter(el => !el.closest('li').parentElement.closest('details:not([open])'))
    const offset = event.key === 'ArrowDown' ? 1 : -1
    visible[visible.indexOf(row) + offset]?.focus()
  }
})

function baseUrl(url) {
  const match = pullRequest(url)
  return match && 'https://github.com/' + match[1] + '/pull/' + match[2]
}

function followSelection({ name, anchor, url, clicked, goBack: previous }) {
  if (url.split('#')[0] !== current.url.split('#')[0]) return
  if (previous) return void goBack()
  const line = /^#?(diff-[0-9a-f]{64})([RL])(\d+)(?:-[RL]\d+)?$/.exec(anchor)
  const path = isFullDiff(url) && line ? current.paths.get('#' + line[1]) : undefined
  const side = line?.[2]
  const number = Number(line?.[3])
  const site = { path, number, side }
  const range = changeAt(site)
  if (path) showActiveChange(site, range)
  const item = side === 'L' ? current.analysis.nodes.get(range?.symbol) : selectionAt(current.analysis, name, path, number)
  const summary = range?.control ?? current.testFiles.get(path) ?? current.summaries.get(item?.id) ?? current.files.get(path)
  if (!path && !item) return
  if (!path) {
    const definition = item.definitions[0] ?? item.changes.values().next().value
    if (definition) showActiveChange(definition)
    else {
      showEnum(undefined)
      current.variable = undefined
      current.activeLine = undefined
      current.matches = []
      updateDetails()
      current.site = undefined
    }
  }
  const expanded = Boolean(range || (name && item?.name === name))
  const parent = summary?.parentElement
  const branch = summary?.matches('summary') && !expanded ? parent.parentElement.closest('details') : parent?.closest('details')
  const newlyOpened = branch && !branch.open
  openBranch(branch)
  const moved = current.selectedSummary !== summary
  showSymbol(item, summary)
  if (!current.enumDetail && clicked && path && side === 'R' && name && showAssertions(path, number, name)) return
  if (moved || newlyOpened) summary?.scrollIntoView({ block: 'nearest' })
}

function applyTheme({ scheme, colors }) {
  const style = document.documentElement.style
  style.colorScheme = scheme
  for (const key of ['surface', 'text', 'muted', 'line', 'accent', 'tint', 'plus', 'minus']) {
    const property = '--' + key
    if (colors[key]) style.setProperty(property, colors[key])
    else style.removeProperty(property)
  }
}

function followTab(url) {
  if (!current.paths) return
  const page = url.split('#')[0]
  if (current.renamePage !== page && isFullDiff(url)) {
    current.renamePage = page
    chrome.tabs.sendMessage(tabId, { type: 'rename-lines', page, selectors: current.renameSelectors }, { frameId: 0 }).catch(() => {})
  }
  const hash = new URL(url).hash
  if (current.hash !== hash) {
    current.hash = hash
    if (hash) followSelection({ anchor: hash, url })
  }
  if (!isFullDiff(url) && current.viewed?.size) showViewed([])
  if (current.port) return
  const snapshot = current
  const port = chrome.tabs.connect(current.tab, { name: 'diff-selection', frameId: 0 })
  current.port = port
  if (!back.disabled) port.postMessage?.({ canGoBack: true })
  port.onMessage.addListener(selection => {
    if (current !== snapshot || baseUrl(selection.url) !== snapshot.base) return
    if (selection.theme) applyTheme(selection.theme)
    else if (selection.viewed) {
      if (isFullDiff(selection.url) && isFullDiff(current.url)) showViewed(selection.viewed)
    } else followSelection(selection)
  })
  port.onDisconnect.addListener(() => {
    // An already open tab acquires the content script on its next page load.
    void chrome.runtime.lastError
    snapshot.port = null
  })
}

async function sync(force = false) {
  const revision = ++version
  const tab = await chrome.tabs.get(tabId)
  if (version !== revision) return
  const base = baseUrl(tab?.url)
  if (!force && current && current.base === base && current.tab === tab?.id) {
    const pageChanged = current.url?.split('#')[0] !== tab?.url?.split('#')[0]
    current.url = tab?.url
    if (base && pageChanged) current.renamePage = undefined
    if (base) followTab(current.url)
    return
  }
  if (current?.renameSelectors) {
    chrome.tabs.sendMessage(tabId, { type: 'rename-lines', page: current.renamePage, selectors: '' }, { frameId: 0 }).catch(() => {})
  }
  current?.port?.disconnect()
  request?.abort()
  enumDetail.hidden = main.hidden = callers.hidden = true
  fileGroups.replaceChildren()
  changes.hidden = true
  tree.replaceChildren()
  reload.hidden = !base
  incoming.replaceChildren()
  select.replaceChildren()
  back.disabled = true
  variants.hidden = true
  current = { history: [], base, url: tab?.url, tab: tab?.id }
  if (!base) {
    status.textContent = 'Open Files changed in a GitHub pull request.'
    return
  }
  const snapshot = current
  request = new AbortController()
  status.textContent = 'Reading the pull request diff…'
  try {
    const [diff, displayedPaths] = await Promise.all([
      readDiff(base, request.signal),
      chrome.tabs.sendMessage(tab.id, { type: 'file-order' }, { frameId: 0 }).catch(() => undefined),
    ])
    if (current !== snapshot) return
    const analysis = buildGraph(diff)
    const contexts = changeContexts(diff, analysis, displayedPaths)
    const filenames = new Set(analysis.lines.keys())
    for (const group of reviewSnapshot(diff, contexts)) for (const file of group.files) filenames.add(file.path)
    const paths = new Map(await Promise.all([...filenames].map(async path => [await fileHash(path), path])))
    if (current !== snapshot) return
    current.analysis = { nodes: analysis.nodes, lines: analysis.lines, assertions: analysis.assertions, enums: analysis.enums }
    current.renameSelectors = [...paths].flatMap(([file, path]) =>
      Object.entries(analysis.renamedLines.get(path) ?? {}).map(([side, numbers]) => {
        const rows = numbers.map(number => `[data-line-number="${number}"]`).join(',')
        return `${file} td[data-diff-side="${side}"]:not([data-selected="true"]):is(${rows})`
      })
    ).join(',')
    const sorted = [...analysis.nodes.values()].sort((a, b) => b.changed - a.changed || b.changes.size - a.changes.size || a.name.localeCompare(b.name))
    showChanges(contexts)
    showVariants(analysis.argumentChanges)
    current.paths = paths
    showViewed([])
    if (!sorted.length) {
      followTab(current.url)
      status.textContent = changes.hidden ? 'No recognizable functions or calls in the new-side diff.' : ''
      return
    }
    const changed = element('optgroup', '')
    changed.label = 'Added or modified'
    const context = element('optgroup', '')
    context.label = 'In diff context'
    for (const item of sorted) {
      const option = element('option', item.name + ' · ' + item.id.split(':')[0])
      option.value = item.id
      const group = item.changed ? changed : context
      group.append(option)
    }
    if (changed.children.length) select.append(changed)
    if (context.children.length) select.append(context)
    render()
    followTab(current.url)
    status.textContent = ''
  } catch (error) {
    if (current === snapshot) status.textContent = 'Could not load the call map. ' + error.message
  }
}

select.onchange = () => followSymbol(select.value)
reload.onclick = () => sync(true)
chrome.tabs.onUpdated.addListener((id, change) => {
  if (id === tabId && (change.url || change.status === 'complete')) sync()
})
if (Number.isInteger(tabId)) {
  await sync()
} else status.textContent = 'Open the map from a GitHub pull request.'
