import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../extension/graph.mjs'
import { changeContexts } from '../extension/changes.mjs'

function contexts(files, displayedPaths) {
  const diff = files.map(([path, ...lines]) => [
    'diff --git a/' + path + ' b/' + path, '--- a/' + path, '+++ b/' + path,
    ...(lines.length ? ['@@ -1 +1 @@', ...lines] : ['Binary files differ']),
  ].join('\n')).join('\n')
  const graph = buildGraph(diff)
  return changeContexts(diff, graph, displayedPaths)
}

test('shows files in their module and attaches a matching test file to the implementation', () => {
  const groups = contexts([
    ['app/net/send.c', '+int send(void) { return 1; }'],
    ['app/net/inc/config.h', '+#define PORT 8'],
    ['tests/test_send.cc', '+TEST_CASE("sends") { send(); }'],
    ['app/ui/status.md', '-Old state', '+New state'],
    ['icons/icon.png'],
  ])
  assert.deepEqual(groups.map(group => group.label), ['net', 'ui', 'icons'])
  const net = groups[0]
  const send = net.files.find(file => file.path.endsWith('/send.c'))
  assert.equal(net.testCount, 1)
  assert.equal(send.testCount, 1)
  assert.deepEqual(send.testFiles.map(root => root.testPath), ['tests/test_send.cc'])
  assert.ok(net.files.every(file => !file.path.startsWith('tests/')))
})

test('ambiguous test filenames do not add tests to unrelated source files', () => {
  const groups = contexts([
    ['client/net/socket.js', '+function connect() {}'],
    ['server/net/socket.js', '+function accept() {}'],
    ['tests/socket.test.js', '+test("ready", () => check())'],
  ])
  for (const key of ['client/net','server/net']) assert.equal(groups.find(group => group.path === key).testCount, 0)
  assert.ok(groups.every(group => group.label !== 'Tests'))
  assert.deepEqual(contexts([]), [])
})

test('keeps a cross-module rename together and counts a mixed reference as its underlying edit', () => {
  const groups = contexts([
    ['app/tasks/job.c', '-void oldJob(void) { work(); }', '+void newJob(void) { work(); }'],
    ['app/boot/start.c', '-  schedule(oldJob, 1);', '+  schedule(newJob, 2);'],
  ])
  assert.deepEqual(groups.map(group => [group.label, group.size]), [['tasks', 1], ['boot', 2]])
  assert.equal(groups[0].children[0].children.length, 2)
})

test('a case calling two functions in a file counts once, including in the module total', () => {
  const [group] = contexts([
    ['net/send.js', '+function send() {}', '+function ack() {}'],
    ['net/read.js', '+function read() {}'],
    ['tests/flow.test.js', '+test("both", () => { send(); ack(); read() })'],
  ]).filter(group => group.path === 'net')
  assert.deepEqual(group.files.map(file => [file.label, file.testCount]), [['send.js', 1], ['read.js', 1]])
  assert.equal(group.testCount, 1)
})

test('counts added and deleted test lines once per module, including test helpers', () => {
  const groups = contexts([
    ['net/send.js', '+function send() {}'], ['net/read.js', '+function read() {}'],
    ['tests/send.test.js', ' test("both", () => {', '   send(); read()', '-  expect(1)', '+  expect(2)', ' })', '+const timeout = 150'],
  ])
  const [net] = groups
  assert.deepEqual([net.testCount, net.testLines], [1, 3])
  assert.deepEqual(net.files.map(file => [file.label, file.testLines]).sort(), [['read.js', 2], ['send.js', 3]])
})

test('counts a completely removed test and keeps fixture lines distinct from cases', () => {
  const [net] = contexts([['net/send.js', '+function send() {}'],
    ['net/tests/send.test.js', '-test("sends", () => send())'], ['net/tests/data.txt', '-old', '+new']])
  assert.deepEqual([net.testCount, net.testLines], [1, 3])
  assert.deepEqual(net.files.map(file => [file.testCount, file.testLines]), [[1, 1]])
})

test('counts separate removed cases with the same title', () => {
  const [group] = contexts([['net/send.js', '+function send() {}'], ['tests/send.test.js',
    '-test("works", () => send(1))', '-test("works", () => send(2))']])
  assert.deepEqual([group.testCount, group.testLines], [2, 2])
})

test('keeps a public header with its implementation and leaves test code out of production changes', () => {
  const [net] = contexts([
    ['app/net/run.c', '-void oldJob(void) { work(); }', '+void newJob(void) { work(); }'],
    ['include/public/run.h', '+#define RETRIES 2'],
    ['tests/run_test.c', '-void verify(void) { oldJob(); }', '+void verify(void) { newJob(); }'],
  ])
  assert.deepEqual(net.files.map(file => file.path).sort(), ['app/net/run.c', 'include/public/run.h'])
  assert.ok(net.files.every(file => file.children.every(change => !change.testPath)))
  assert.equal(net.testLines, 2)
})

test('orders modules by their first file in the diff, including test-only modules and binary files', () => {
  const groups = contexts([
    ['zeta/icon.png'], ['qa/tests/data.txt', '+fixture'], ['docs/hello.md', '+one'],
    ['alpha/config.txt', '+one', '+two', '+three'], ['zeta/extra.txt', '+two'],
  ])
  assert.deepEqual(groups.map(group => group.label), ['zeta', 'qa', 'docs', 'alpha'])
})

test('a partial GitHub file list falls back to diff order', () => {
  const groups = contexts([['one/a.png'], ['two/b.txt', '+new']], ['two/b.txt'])
  assert.deepEqual(groups.map(group => group.label), ['one', 'two'])
})

test('module review weights count physical source edits and each associated test line once', () => {
  const [net, ui] = contexts([
    ['net/send.c', '-void oldSend(void) { tick(); }', '+void send(void) { tick(); }'],
    ['net/clock.c', '+void tick(void) {}'], ['net/README.md', '+text'], ['net/icon.png'],
    ['ui/view.c', '+void view(void) {}'],
    ['tests/flow.cc', '+TEST_CASE("both") { send(); tick(); view(); }', '+TEST_CASE("ui") { view(); }'],
  ])
  assert.deepEqual([...net.codeLinesByFile].sort(), [['net/clock.c', 1], ['net/send.c', 2]])
  assert.deepEqual([...net.testLinesByFile], [['tests/flow.cc', 1]])
  assert.deepEqual([...ui.testLinesByFile], [['tests/flow.cc', 2]])
})

test('keeps a C source and its matching header adjacent in the module', () => {
  const files = [
    ['net/inc/run.h', '+#define RUN 1', '+#define LIMIT 2', '+#define READY 3'],
    ['net/other.c', '+int other;', '+int again;'],
    ['net/run.c', '+void run(void) {}'],
  ]
  const [net] = contexts(files)
  assert.deepEqual(net.files.map(file => file.label), ['run.h', 'run.c', 'other.c'])
  const [displayed] = contexts(files, ['net/run.c', 'net/other.c', 'net/inc/run.h'])
  assert.deepEqual(displayed.files.map(file => file.label), ['run.c', 'run.h', 'other.c'])
})

test('lists functions by their line in the file before larger changes below them', () => {
  const [group] = contexts([
    ['net/run.js', '+function zebra() {}', '+const mode = 1', '',
      '+function alpha() {', '+  start()', '+  stop()', '+}'],
  ])
  assert.deepEqual(group.files[0].children.map(child => child.label ?? child.site.number), ['zebra', 2, 'alpha'])
})
