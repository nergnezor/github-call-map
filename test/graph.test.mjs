import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { buildGraph, lineHash, pullRequest, selectionAt } from '../extension/graph.mjs'

function patch(path, lines) {
  return 'diff --git a/x b/x\n+++ ' + path + '\n' + lines.join('\n')
}

test('follows a changed call across two files, keeping the right-side line', () => {
  const { nodes } = buildGraph([
    patch('b/ui.js', ['@@ -20,3 +21,3 @@ function submit() {', '-  old()', '+  save()', '   done()', ' }']),
    patch('b/storage.ts', ['@@ -0,0 +1,1 @@', '+export function save() { write() }']),
  ].join('\n'))
  const save = nodes.get('js:save')
  assert.deepEqual(save.incoming.map(call => [call.owner.name, call.path, call.number, call.added]), [['submit', 'ui.js', 21, true]])
  assert.equal(save.outgoing[0].target.name, 'write')
  assert.equal(save.definitions[0].number, 1)
  assert.equal(nodes.get('js:done').incoming[0].added, false)
  assert.equal(nodes.has('js:old'), false)
})

test('isolates hunk context and ignores strings, comments, deleted and unsupported files', () => {
  const { nodes } = buildGraph([
    patch('b/order.cpp', ['@@ -1,0 +1,5 @@', '+void enter()', '+{', '+  /*', '+    ignored(); */ print("fake()"); // skip()', '+}', '@@ -40,0 +40,1 @@', '+tick();']),
    patch('/dev/null', ['@@ -1 +0,0 @@', '-deleted();']),
    patch('b/doc.md', ['@@ -0,0 +1 @@', '+example()']),
  ].join('\n'))
  assert.deepEqual([...nodes.keys()], ['c:enter', 'c:print', 'c:tick'])
  assert.equal(nodes.get('c:tick').incoming[0].owner, undefined)
})

test('keeps overload locations and isolates names between language families', () => {
  const { nodes } = buildGraph([
    patch('b/one.rs', ['@@ -0,0 +1 @@', '+fn run() { run() }']),
    patch('b/two.rs', ['@@ -0,0 +1 @@', '+pub fn run() { other() }']),
    patch('b/three.kt', ['@@ -0,0 +1 @@', '+fun run() { next() }']),
  ].join('\n'))
  assert.equal(nodes.get('rust:run').definitions.length, 2)
  assert.equal(nodes.get('rust:run').incoming.length, 1)
  assert.equal(nodes.get('kotlin:run').outgoing[0].target.name, 'next')
})

test('restores the enclosing function after an inner declaration', () => {
  const { nodes } = buildGraph(patch('b/main.js', ['@@ -0,0 +1,5 @@', '+function parent() {', '+  function inner() { first() }', '+  second()', '+}', '+third()']))
  assert.equal(nodes.get('js:first').incoming[0].owner.name, 'inner')
  assert.equal(nodes.get('js:second').incoming[0].owner?.name, 'parent')
  assert.equal(nodes.get('js:third').incoming[0].owner, undefined)
})

test('includes Kotlin expression bodies and excludes C prototypes from call sites', () => {
  const { nodes } = buildGraph([
    patch('b/Repo.kt', ['@@ -0,0 +1 @@', '+fun next() = load()']),
    patch('b/Repo.h', ['@@ -0,0 +1 @@', '+extern int load(void);']),
  ].join('\n'))
  assert.equal(nodes.get('kotlin:next').outgoing[0]?.target.name, 'load')
  assert.equal(nodes.get('c:load')?.incoming.length ?? 0, 0)
})

test('links a changed function identified only by the hunk heading', () => {
  const { nodes } = buildGraph(patch('b/test.rs', ['@@ -12 +12 @@ fn count() -> usize {', '-    1', '+    2']))
  assert.deepEqual(nodes.get('rust:count').changes.get('test.rs'), { path: 'test.rs', number: 12, added: true })
})

test('hashes the decoded UTF-8 path of a renamed file', async () => {
  const { nodes } = buildGraph(patch('"b/ny r\\303\\244tt.ts"', ['@@ -0,0 +15 @@', '+const go = () => run()']))
  const { path, number } = nodes.get('js:run').incoming[0]
  assert.equal(path, 'ny rätt.ts')
  assert.equal(await lineHash(path, number), '#diff-' + createHash('sha256').update('ny rätt.ts').digest('hex') + 'R15')
})

test('recognizes both GitHub diff views and rejects other hosts and pages', () => {
  for (const page of ['changes', 'files', 'changes/123abc?plain=1#diff-abc']) {
    assert.equal(pullRequest('https://github.com/org/repo/pull/51/' + page)[2], '51')
  }
  for (const url of ['https://github.com/org/repo/pull/51', 'https://github.com.example/org/repo/pull/51/files', 'https://github.com/org/repo/pull/51/files.txt', undefined]) {
    assert.ok(!pullRequest(url))
  }
})

test('recognizes C++ functions with parameters on separate lines', () => {
  const { nodes } = buildGraph(patch('b/session.cpp', ['@@ -0,0 +1,6 @@', '+bool Session::Connect(', '+    const Device& device)', '+{', '+    return Open(device);', '+}', '+']))
  assert.equal(nodes.get('c:Open').incoming[0].owner?.name, 'Connect')
})

test('keeps the body after Rust lifetimes and character literals', () => {
  const { nodes } = buildGraph(patch('b/input.rs', ['@@ -0,0 +1 @@', "+fn name<'a>(value: &'a str) { parse('('); save() }"]))
  assert.deepEqual(nodes.get('rust:name').outgoing.map(call => call.target.name), ['parse', 'save'])
})

test('selects the clicked callee or the enclosing function on a new-side diff line', () => {
  const graph = buildGraph([
    patch('b/input.rs', ['@@ -20,3 +20,4 @@ fn read() {', '-    old()', '+    send(load())', '     let n = 1;', ' }', '+outside()']),
    patch('b/input.ts', ['@@ -0,0 +1 @@', '+function send() { flush() }']),
  ].join('\n'))
  assert.equal(selectionAt(graph, 'send', 'input.rs', 20)?.id, 'rust:send')
  assert.equal(selectionAt(graph, 'load', 'input.rs', 20)?.id, 'rust:load')
  assert.equal(selectionAt(graph, '', 'input.rs', 21)?.id, 'rust:read')
  assert.equal(selectionAt(graph, '', 'input.rs', 23), undefined)
  assert.equal(selectionAt(graph, 'send'), undefined)
  assert.equal(selectionAt(graph, 'flush')?.id, 'js:flush')
  assert.equal(selectionAt(graph, 'absent'), undefined)
})

test('marks only new call sites when rewriting a line and keeps callees separate from changed definitions', () => {
  const graph = buildGraph([
    'diff --git a/old.js b/new.js', '--- a/old.js', '+++ b/new.js',
    '@@ -8,3 +20,4 @@ function run() {',
    '   context()', '-  save(oldValue)', '-  cache.get(key)',
    '+  save(transform(value))', '+  store.get(key)', '+  save(extra)',
  ].join('\n'))
  const calls = graph.nodes.get('js:run').outgoing
  assert.deepEqual(calls.map(call => [call.target.name, call.number, call.added]), [
    ['context', 20, false], ['save', 21, false], ['transform', 21, true],
    ['get', 22, true], ['save', 23, true],
  ])
  assert.equal(graph.nodes.get('js:transform').changed, false)
  assert.equal(graph.nodes.get('js:run').changed, true)
})

test('matches moved calls before assigning duplicates and keeps different callers separate', () => {
  const graph = buildGraph([
    'diff --git a/input.js b/input.js', '--- a/input.js', '+++ b/input.js',
    '@@ -4,1 +4,2 @@ function first() {', '-  send(original)',
    '+  send(extra)', '+  send(original)',
    '@@ -22 +23 @@ function batch() {', '-  save(original)', '+  save(extra); save(original)',
    '@@ -50,1 +51,0 @@ function first() {', '-  log()',
    '@@ -60,0 +61,1 @@ function second() {', '+  log()',
  ].join('\n'))
  assert.deepEqual(graph.nodes.get('js:send').incoming.map(call => call.added), [true, false])
  assert.deepEqual(graph.nodes.get('js:save').incoming.map(call => call.added), [true, false])
  assert.equal(graph.nodes.get('js:log').incoming[0].added, true)
})

test('a static counter declaration links to its new-side uses across hunks in the same C file', () => {
  const declaration = '+static _Atomic uint32_t displayed_frames;'
  const diff = [
    patch('b/metrics.c', ['@@ -28,0 +29,1 @@', declaration,
      '@@ -41,4 +42,6 @@ void display(void)', ' {', '+  atomic_fetch_add(&displayed_frames, 1);',
      '   note("displayed_frames"); // displayed_frames', '+  other->displayed_frames++;', ' }',
      '@@ -60,2 +61,2 @@ void reset(void)', '   atomic_store(&displayed_frames, 0);', ' }',
      '@@ -76,2 +77,2 @@ void report(void)', '-  read(displayed_frames);', '+  take(atomic_exchange(&displayed_frames, 0));', ' }']),
    patch('b/unrelated.c', ['@@ -0,0 +1,2 @@', declaration, '+int read(void) { return displayed_frames; }']),
  ].join('\n')
  const variable = buildGraph(diff).lines.get('metrics.c').get(29).variable
  assert.equal(variable.name, 'displayed_frames')
  assert.deepEqual(variable.uses.map(site => [site.path, site.number]), [['metrics.c', 43], ['metrics.c', 61], ['metrics.c', 77]])
})

test('a parameter or a nested local with the same name hides a static counter', () => {
  const diff = patch('b/counters.c', ['@@ -0,0 +1,9 @@', '+static unsigned frames;',
    '+void a(unsigned frames) {', '+  emit(frames);', '+}', '+void b(void) {',
    '+  { unsigned frames = 1;', '+    emit(frames); }', '+  emit(frames);', '+}'])
  assert.deepEqual(buildGraph(diff).lines.get('counters.c').get(1).variable.uses.map(site => site.number), [8])
})

test('a C hunk heading does not own file-scope enums after a prototype', () => {
  const diff = patch('b/metrics.c', ['@@ -19,3 +19,7 @@ void report_at(unsigned now)',
    ' ', ' void send(const struct Metrics *metrics);', ' ',
    '+enum {', '+    DROP_REASONS = 4,', '+    MS_PER_SECOND = 1000', '+};'])
  const graph = buildGraph(diff)
  for (const line of [22, 23, 24, 25]) assert.equal(graph.lines.get('metrics.c').get(line).owner, undefined)
  assert.equal(graph.nodes.get('c:report_at').changed, false)
})

test('a truncated C diff heading identifies the caller around a context line', () => {
  const diff = patch('b/render.c', ['@@ -49,2 +123,2 @@ unsigned render_test_flush_and_replace(uint16_t first_x, uint32',
    '+    start_video();', '     RenderNextRegion();'])
  const call = buildGraph(diff).nodes.get('c:RenderNextRegion').incoming[0]
  assert.equal(call.number, 124)
  assert.equal(call.owner?.name, 'render_test_flush_and_replace')
})
