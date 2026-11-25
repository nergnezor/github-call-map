import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import vm from 'node:vm'

function load(file, globals) {
  return vm.runInNewContext(readFileSync(new URL('../extension/' + file, import.meta.url), 'utf8'), globals)
}
function event() {
  return { addListener(listener) { this.fire = listener } }
}

test('the map follows its PR tab and a delayed restore cannot reopen a closed map', async () => {
  const message = event()
  const navigation = new EventTarget()
  const location = { pathname: '/org/repo/pull/7/changes' }
  const frames = new Set()
  const state = Promise.withResolvers()
  const document = {
    createElement() { return { contentWindow: {}, remove() { frames.delete(this); this.isConnected = false } } },
    documentElement: { append(frame) { frame.isConnected = true; frames.add(frame) } },
  }
  load('dock.js', { document, location, navigation, chrome: {runtime: {
    id: 'test', onMessage: message, getURL: file => 'chrome-extension://test/' + file, sendMessage: () => state.promise,
  }} })
  message.fire({ type: 'dock', open: true })
  assert.deepEqual([...frames].map(frame => frame.src), ['chrome-extension://test/panel.html'])
  location.pathname = '/org/repo/issues'
  navigation.dispatchEvent(new Event('navigatesuccess'))
  assert.equal(frames.size, 0)
  location.pathname = '/org/repo/pull/8/files'
  navigation.dispatchEvent(new Event('navigatesuccess'))
  assert.equal(frames.size, 1)
  message.fire({ type: 'dock', open: false })
  state.resolve(true)
  await state.promise
  assert.equal(frames.size, 0)
})

test('navigation after an extension reload removes the old frames', async () => {
  const location = new URL('https://github.com/org/repo/pull/7/changes')
  const frames = new Set()
  const document = {
    createElement() { return { remove() { this.isConnected = false; frames.delete(this) } } },
    documentElement: { append(frame) { frame.isConnected = true; frames.add(frame) } },
  }
  const runtime = {
    id: 'test', onMessage: event(), sendMessage: async () => true,
    getURL(file) {
      if (!this.id) throw new Error('Extension context invalidated.')
      return 'chrome-extension://test/' + file
    },
  }
  const navigation = {
    addEventListener(type, fn) { this.listener = fn },
    removeEventListener(type, fn) { if (fn === this.listener) this.listener = null },
  }
  await load('dock.js', { chrome: { runtime }, document, location, navigation })
  assert.equal(frames.size, 1)
  runtime.id = undefined
  const [panel] = frames
  panel.remove()
  navigation.listener()
  assert.equal(frames.size, 0)
  assert.equal(navigation.listener, null)
})

test('the initial dock request can be invalidated before the worker replies', async () => {
  const state = Promise.withResolvers()
  const runtime = { id: 'test', onMessage: event(), sendMessage: () => state.promise }
  const restored = load('dock.js', { chrome: { runtime }, navigation: new EventTarget() })
  runtime.id = undefined
  state.reject(new Error('Extension context invalidated.'))
  await restored
})

test('a diff opens by default and the toolbar toggles its state', async () => {
  const action = event()
  const runtimeMessage = event()
  const saved = {}
  const messages = []
  const tab = {id: 4, url: 'https://github.com/org/repo/pull/7/changes'}
  load('worker.js', { chrome: {
    action: {onClicked: action}, runtime: {onMessage: runtimeMessage},
    storage: {session: {
      get: async () => ({...saved}), set: async value => Object.assign(saved, value), remove: async key => delete saved[key],
    }},
    tabs: {sendMessage: async (id, msg) => messages.push([id, msg.open]), onRemoved: event()},
  } })
  const state = () => new Promise(resolve => runtimeMessage.fire('dock-state', {tab, frameId: 0}, resolve))
  assert.equal(await state(), true)
  await action.fire(tab)
  assert.equal(await state(), false)
  await action.fire(tab)
  assert.equal(await state(), true)
  assert.deepEqual(messages, [[4, false], [4, true]])
  assert.deepEqual(saved, {})
})

test('previews the requested side of a range without moving keyboard focus', async () => {
  const message = event()
  const page = 'https://github.com/org/repo/pull/7/files?diff=split'
  const fileId = 'diff-' + 'a'.repeat(64)
  const marked = new Set()
  const scrolls = []
  const left = {
    classList: { add: name => marked.add(name), remove: name => marked.delete(name) },
    checkVisibility: () => true,
    scrollIntoView: options => scrolls.push(options.block),
  }
  const file = { querySelector: selector => selector === '[data-diff-cell="text"][data-diff-side="left"][data-line-number="27"]' ? left : null }
  const document = {
    createElement: () => ({}),
    documentElement: { append(frame) { frame.isConnected = true } },
    getElementById: id => id === fileId ? file : null,
    querySelector: () => null,
  }
  load('dock.js', { document, location: new URL(page), navigation: new EventTarget(), chrome: {runtime: {
    id: 'test', onMessage: message, getURL: file => file, sendMessage: async () => true,
  }} })
  await Promise.resolve()
  function preview(hash, from = page) {
    let shown
    message.fire({ type: 'reveal', hash, page: from }, { url: 'panel.html' }, result => { shown = result })
    return shown
  }
  assert.equal(preview('#' + fileId + 'L27-L30'), true)
  assert.deepEqual(scrolls, ['center'])
  assert.ok(marked.has('pr-call-map-line'))
  assert.equal(preview('#' + fileId + 'L27', page + '&w=1'), false)
  assert.equal(preview('#' + fileId + 'R27'), false)
  assert.equal(marked.size, 0)
})

test('a line link waits for the code cell after GitHub renders the file header', async () => {
  const message = event()
  const navigation = new EventTarget()
  const page = new URL('https://github.com/org/repo/pull/7/changes')
  const fileId = 'diff-' + 'b'.repeat(64)
  const scrolls = []
  const marked = new Set()
  const cell = {
    classList: { add: name => marked.add(name), remove: name => marked.delete(name) },
    checkVisibility: () => true,
    scrollIntoView: () => scrolls.push('R143'),
  }
  let loaded = false
  const file = {
    scrollIntoView: () => scrolls.push('file'),
    querySelector: selector => loaded && selector.includes('[data-line-number="143"]') ? cell : null,
  }
  const document = {
    createElement: () => ({}),
    documentElement: { append(frame) { frame.isConnected = true } },
    getElementById: id => id === fileId ? file : null,
    querySelector: () => null,
  }
  const timers = new Map()
  let id = 0
  load('dock.js', { document, location: page, navigation,
    setTimeout(fn) { timers.set(++id, fn); return id },
    clearTimeout(id) { timers.delete(id) },
    chrome: {runtime: {
      id: 'test', onMessage: message, getURL: file => file, sendMessage: async () => true,
    }},
  })
  await Promise.resolve()
  page.hash = fileId + 'L12'
  navigation.dispatchEvent(new Event('navigatesuccess'))
  page.hash = fileId + 'R143-R145'
  navigation.dispatchEvent(new Event('navigatesuccess'))
  loaded = true
  for (const [key, fire] of [...timers]) {
    timers.delete(key)
    fire()
  }
  assert.equal(scrolls.at(-1), 'R143')
  assert.ok(marked.has('pr-call-map-line'))
  assert.equal(timers.size, 0)
})

test('only the current full diff uses the rename markers from its panel', async () => {
  const page = new URL('https://github.com/org/repo/pull/7/files')
  const navigation = new EventTarget()
  const message = event()
  const document = {
    adoptedStyleSheets: [],
    createElement: () => ({}),
    documentElement: { append(frame) { frame.isConnected = true } },
  }
  class CSSStyleSheet { replaceSync(css) { this.css = css } }
  load('dock.js', { document, CSSStyleSheet, location: page, navigation, chrome: {runtime: {
    id: 'test', onMessage: message, getURL: file => 'chrome-extension://test/' + file, sendMessage: async () => true,
  }} })
  await Promise.resolve()
  const rules = { type: 'rename-lines', page: page.href, selectors: '#diff-test td[data-line-number="34"]' }
  message.fire(rules, {url: page.href}, () => {})
  assert.equal(document.adoptedStyleSheets.length, 0)
  message.fire(rules, {url: 'chrome-extension://test/panel.html'}, () => {})
  assert.match(document.adoptedStyleSheets[0]?.css ?? '', /data-line-number="34"/)
  page.pathname += '/commit'
  navigation.dispatchEvent(new Event('navigatesuccess'))
  assert.equal(document.adoptedStyleSheets.length, 0)
})

test('the host and both panes use the same widths for every selection', () => {
  const css = readFileSync(new URL('../extension/dock.css', import.meta.url), 'utf8')
  const panelCss = readFileSync(new URL('../extension/panel.css', import.meta.url), 'utf8')
  assert.doesNotMatch(css, /data-expanded/)
  assert.match(css, /--pr-pane-width: min\(390px, [\d.]+vw\)/)
  for (const pane of ['context', 'details']) {
    assert.match(panelCss, new RegExp('#' + pane + ' \\{[^}]*width: var\\(--pr-pane-width\\)'))
  }
  assert.match(css, /clip-path: polygon/)
})
