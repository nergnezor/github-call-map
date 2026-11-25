import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph, lineHash } from '../extension/graph.mjs'
import { changeTree } from '../extension/changes.mjs'

function tree(...lines) {
  const diff = lines.join('\n')
  return changeTree(diff, buildGraph(diff))
}

test('shows a shared callee and its callers once each', () => {
  const roots = tree('diff --git a/app.js b/app.js', '+++ b/app.js', '@@ -0,0 +1,3 @@',
    '+function write() { write() }', '+function save() { write() }', '+function copy() { write() }')
  assert.deepEqual(roots.map(root => root.label), ['copy', 'save', 'write'])
  assert.ok(roots.every(root => root.children.length === 1))
})

test('keeps both sides of a replacement together and preserves removed functions', async () => {
  const roots = tree('diff --git a/app.js b/app.js', '--- a/app.js', '+++ b/app.js', '@@ -10,3 +10,2 @@ function run() {',
    '-  before()', '-  more()', '+  after()', ' }',
    'diff --git a/old.rs b/old.rs', '--- a/old.rs', '+++ /dev/null', '@@ -1 +0,0 @@', '-fn old() {}')
  assert.deepEqual(roots.map(root => root.label), ['run', 'old'])
  const ranges = roots[0].children.map(child => child.site)
  assert.deepEqual(ranges.map(site => [site.side, site.number, site.end]), [['L', 10, 11], ['R', 10, 10]])
  assert.match(await lineHash('app.js', 10, 'L', 11), /L10-L11$/)
  assert.equal(roots[1].children[0].site.path, 'old.rs')
})

test('shows documentation ranges, pure renames and binary changes', () => {
  const roots = tree('diff --git a/doc.md b/doc.md', '+++ b/doc.md', '@@ -0,0 +1,2 @@', '+one', '+two',
    'diff --git a/older name b/new', 'similarity index 100%', 'rename from older name', 'rename to new',
    'diff --git a/a b/icon.png b/a b/icon.png', 'Binary files a/a b/icon.png and b/a b/icon.png differ')
  assert.deepEqual(roots.map(item => item.label), ['doc.md', 'a b/icon.png', 'new'])
  assert.equal(roots[0].children[0].site.end, 2)
  assert.equal(roots[2].site.path, 'new')
  assert.equal(roots[1].site.path, 'a b/icon.png')
})

test('lists members of recursive call chains independently', () => {
  const roots = tree('diff --git a/c.js b/c.js', '+++ b/c.js', '@@ -0,0 +1,3 @@',
    '+function last() {}', '+function a() { b() }', '+function b() { a(); last() }')
  assert.deepEqual(roots.map(root => root.label), ['a', 'b', 'last'])
})

test('shows source text for removed, added and context lines at their own line numbers', () => {
  const diff = [
    'diff --git a/run.js b/run.js', '--- a/run.js', '+++ b/run.js',
    '@@ -40,2 +70,5 @@ function run() {',
    '-  old()', '+  fresh()', '+  <example>', '+', '+  done()', '   keep()',
  ].join('\n')
  const graph = buildGraph(diff)
  const [removed, added] = changeTree(diff, graph)[0].children
  assert.deepEqual(removed.site.preview, ['-  old()'])
  assert.deepEqual(added.site.preview, ['+  fresh()', '+  <example>', '+', '+  done()'])
  assert.equal(graph.lines.get('run.js').get(74).source, '   keep()')
})

test('a renamed function has one neutral link and keeps real body edits in the tree and Calls', () => {
  const diff = [
    'diff --git a/old.js b/new.js', '--- a/old.js', '+++ b/new.js',
    '@@ -10,5 +40,6 @@', '-function load() {', '-  read()', '-  send(1)', '-  finish()', '-}',
    '+function fetchData() {', '+  read()', '+  send(2)', '+  audit()', '+  finish()', '+}',
    '@@ -60 +90 @@ function run() {', '-  load()', '+  fetchData()',
  ].join('\n')
  const graph = buildGraph(diff)
  const roots = changeTree(diff, graph)
  const renamed = roots.find(item => item.symbol === 'js:fetchData')
  assert.equal(renamed.label, 'load → fetchData')
  assert.deepEqual(renamed.children.map(({ site }) => [site.side, site.number, site.end]), [
    ['L', 12, 12], [undefined, 40, 40], ['R', 42, 43], [undefined, 90, 90],
  ])
  assert.equal(renamed.children[1].site.path, 'new.js')
  assert.deepEqual(graph.renamedLines.get('new.js'), { left: [10, 11, 13, 14], right: [40, 41, 44, 45] })
  assert.equal(graph.nodes.get('js:fetchData').definitions[0].added, false)
  assert.deepEqual(graph.nodes.get('js:fetchData').outgoing.map(site => site.added), [false, false, true, false])
  assert.equal(graph.nodes.get('js:run').outgoing[0].added, false)
})

test('a pure recursive rename stays neutral and an unrelated replacement stays a diff', () => {
  const roots = tree('diff --git a/jobs.js b/jobs.js', '--- a/jobs.js', '+++ b/jobs.js',
    '@@ -1,3 +1,3 @@', '-function previous() {', '-  previous()', '-}',
    '+function next() {', '+  next()', '+}',
    '@@ -20,3 +20,3 @@', '-function stop() {', '-  shutdown()', '-}',
    '+function start() {', '+  boot()', '+}')
  assert.deepEqual(roots.map(item => item.label), ['start', 'stop', 'previous → next'])
  assert.deepEqual(roots[2].children.map(({ site }) => site.side), [undefined, undefined])
})

test('a one-line rename also uses a neutral line in the GitHub diff', () => {
  const diff = ['diff --git a/api.js b/api.js', '--- a/api.js', '+++ b/api.js',
    '@@ -7 +9 @@', '-function load() { return read() }', '+function fetchData() { return read() }'].join('\n')
  assert.deepEqual(buildGraph(diff).renamedLines.get('api.js'), { left: [7], right: [9] })
})

test('keeps SendPing neutral when PingTask is renamed and reindented', () => {
  const diff = [
    'diff --git a/message_v1.c b/message_v1.c', '--- a/message_v1.c', '+++ b/message_v1.c',
    '@@ -36 +37 @@', '-static void PingTask(void *argument);', '+static void PingAndMetricsTask(void *argument);',
    '@@ -107,7 +119,7 @@', '-static void PingTask(void *argument)', '+static void PingAndMetricsTask(void *argument)',
    ' {', '-\tif (atomic_load(&ping_task_enabled))', '-\t{', '-\t\tSendPing();', '-\t}',
    '+    if (ping_and_metrics_enabled) {', '+        SendPing();',
    '+        ReportMetricsAt(now);', '+    }', ' }',
  ].join('\n')
  const graph = buildGraph(diff)
  const task = graph.nodes.get('c:PingAndMetricsTask')
  assert.equal(task.renamedFrom, 'PingTask')
  assert.deepEqual(task.outgoing.map(site => [site.target.name, site.added]), [
    ['SendPing', false], ['ReportMetricsAt', true],
  ])
  assert.ok(task.definitions.every(site => !site.added))
  const [branch] = changeTree(diff, graph)
  assert.equal(branch.label, 'PingTask → PingAndMetricsTask')
  assert.ok(!branch.children.some(({ site }) => site?.side && site.preview.some(line => line.includes('SendPing'))))
})

test('a second declaration added during a rename keeps its addition marker', () => {
  const diff = [
    'diff --git a/job.c b/job.c', '--- a/job.c', '+++ b/job.c',
    '@@ -1 +1,2 @@', '-void before(void);', '+void after(void);', '+void after(void);',
    '@@ -20 +21 @@', '-void before(void) { send(); }', '+void after(void) { send(); }',
  ].join('\n')
  const sites = buildGraph(diff).nodes.get('c:after').definitions
  assert.deepEqual(sites.map(site => site.added), [false, true, false])
})

test('a small replacement shares one preview and keeps both line targets', () => {
  const [file] = tree('diff --git a/config.md b/config.md', '@@ -12 +18 @@',
    '-count = 1', '+count = 2')
  assert.equal(file.children.length, 1)
  const { site } = file.children[0]
  assert.deepEqual(site.inline, { prefix: 'count = ', removed: '1', added: '2', suffix: '' })
  assert.deepEqual([site.previous.side, site.previous.number, site.side, site.number], ['L', 12, 'R', 18])
})

test('unrelated statements or changes across context lines keep separate links', () => {
  const [file] = tree('diff --git a/config.md b/config.md', '@@ -1,3 +1,3 @@',
    '-    boot()', '+    stop()', '-count = 1', ' # settings', '+count = 2')
  assert.ok(file.children.every(({ site }) => !site.inline))
})

test('a renamed declaration highlights the inserted name fragment inside the code', () => {
  const [branch] = tree('diff --git a/task.c b/task.c', '--- a/task.c', '+++ b/task.c',
    '@@ -4 +4 @@', '-void PingTask(void) { ping(); }', '+void PingAndMetricsTask(void) { ping(); }')
  assert.deepEqual(branch.children[0].site.inline, {
    prefix: 'void Ping', removed: '', added: 'AndMetrics', suffix: 'Task(void) { ping(); }',
  })
})

test('groups a rename with uses in another file and keeps additional edits visible', () => {
  const roots = tree('diff --git a/job.c b/job.c','--- a/job.c','+++ b/job.c',
    '@@ -1 +1 @@','-void oldJob(void) { work(); }','+void newJob(void) { work(); }',
    'diff --git a/start.c b/start.c','--- a/start.c','+++ b/start.c',
    '@@ -2 +2 @@ void start(void)', '-  schedule(oldJob);', '+  schedule(newJob);',
    '@@ -8 +8 @@ void retry(void)', '-  schedule(oldJob, 1);', '+  schedule(newJob, 2);')
  const renamed = roots.find(group => group.symbol === 'c:newJob')
  assert.deepEqual(renamed.children.map(({ site }) => [site.path, site.number]), [
    ['job.c',1], ['start.c',2], ['start.c',8],
  ])
  assert.ok(!roots.some(group => group.label === 'start'))
  assert.ok(roots.some(group => group.label === 'retry'))
})

test('orders all change groups by size including text and binary files', () => {
  const groups = tree('diff --git a/api.js b/api.js','+++ b/api.js','@@ -0,0 +1,2 @@',
    '+function caller() { callee() }','+function callee() {}',
    'diff --git a/notes.md b/notes.md','+++ b/notes.md','@@ -0,0 +1,4 @@','+a','+b','+c','+d',
    'diff --git a/logo.png b/logo.png','Binary files differ')
  assert.deepEqual(groups.map(group => [group.label, group.size]), [
    ['notes.md',4], ['callee',1], ['caller',1], ['logo.png',0],
  ])
})
