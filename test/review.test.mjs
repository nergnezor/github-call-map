import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../extension/graph.mjs'
import { changeContexts } from '../extension/changes.mjs'
import { reviewSnapshot, sinceReview } from '../extension/review.mjs'

function file(path, lines) {
  return ['diff --git a/' + path + ' b/' + path, '--- a/' + path, '+++ b/' + path, ...lines].join('\n')
}

test('groups the same inserted argument across callers and identifies a strict majority', () => {
  const diff = file('src/net.js', Array.from({length: 6}, (_, i) => [
    '@@ -' + (i+1) + ' +' + (i+10) + ' @@ function run' + i + '() {',
    '-  client.send(value' + i + ')', '+  client.send(value' + i + ', ' + (i < 5) + ')',
  ]).flat())
  const [pattern] = buildGraph(diff).argumentChanges
  assert.deepEqual([pattern.name, pattern.position], ['client.send', 2])
  assert.deepEqual(pattern.variants.map(v => [v.value,v.sites.length,v.exception]), [['true',5,false],['false',1,true]])
  assert.equal(pattern.variants[1].sites[0].number,15)
})

test('keeps tied replacements neutral and ignores unchanged, ambiguous and test calls', () => {
  const diff = file('src/net.js', ['@@ -1,4 +1,4 @@',
    '-  send(pair(1, 2), 0)', '+  send(pair(1, 2), 1)', ' keep()',
    '-  send("a,b", 0)', '+  send("a,b", 2)', ' keep()',
    '-  send(3, 2)', '+  send(3, 2)']) + '\n' +
    file('tests/net.js', ['@@ -1 +1 @@','-send(a, 0)','+send(a, 1)'])
  const [pattern] = buildGraph(diff).argumentChanges
  assert.deepEqual(pattern.variants.map(v=>[v.value,v.sites.length,v.exception]),[['1',1,false],['2',1,false]])
})

function snapshot(diff) {
  const graph = buildGraph(diff)
  return reviewSnapshot(diff, changeContexts(diff, graph))
}
test('compares complete changed code with the reviewed version and includes vanished groups', () => {
  const before = snapshot(file('docs/a.md', ['@@ -0,0 +1,5 @@','+a','+b','+c','+d','+old']) + '\n' +
    file('icons/b.png',['Binary files differ']))
  const after = snapshot(file('docs/a.md', ['@@ -0,0 +10,5 @@','+a','+b','+c','+d','+new']))
  assert.deepEqual(sinceReview(before,before), [])
  const changes = sinceReview(before,after)
  assert.deepEqual(changes.map(c => c.key).sort(),['docs','icons'])
  const [edit] = changes.find(c=>c.key==='docs').files
  assert.deepEqual([edit.before,edit.after],[['+old'],['+new']])
})

test('indexes exact field names from every assertion in a changed case', () => {
  const graph = buildGraph(file('tests/metrics.cc',['@@ -0,0 +1,7 @@','+TEST_CASE("sends") {',
    '+  CHECK(a);','+  CHECK(b);','+  CHECK(c);','+  CHECK(link->transmit_kbps() == 16);',
    '+  CHECK(label == "bogus_field");','+}']))
  const [match] = graph.assertions.get('c:transmit_kbps')
  assert.deepEqual([match.name,match.number,match.code],['sends',5,'CHECK(link->transmit_kbps() == 16);'])
  assert.equal(graph.assertions.has('c:bogus_field'),false)
})

test('a change moved to another base line is visible, while offsets on the new side alone are ignored', () => {
  const at = (left,right) => snapshot(file('src/read.js', ['@@ -'+left+' +'+right+' @@ function read() {','-  off()','+  on()']))
  assert.equal(sinceReview(at(10,10), at(10,20)).length, 0)
  assert.equal(sinceReview(at(10,10), at(30,30)).length, 1)
})

test('ignores unmatched calls, incomplete arguments and ambiguous rewrites', () => {
  const diff = file('src/net.js', ['@@ -1,2 +1,2 @@','-send(a, 0)','-send(b, 1)','+send(a, 1)','+send(b, 0)',
    '@@ -8 +8 @@','-send(a,','+send(a,', '@@ -20 +20 @@','-old.send(a)','+new.send(a, false)'])
  assert.deepEqual(buildGraph(diff).argumentChanges,[])
})

test('an existing review point with a Tests group follows the same files into their modules', () => {
  const diff = file('net/stream.js', ['@@ -0,0 +1 @@', '+function send() {}']) + '\n' +
    file('tests/stream.test.js', ['@@ -0,0 +1 @@', '+test("sends", () => send())'])
  const current = snapshot(diff)
  const [net] = current
  const saved = [{ ...net, files: net.files.filter(file => file.path.startsWith('net/')) },
    { key: 'Tests', label: 'Tests', files: net.files.filter(file => file.path.startsWith('tests/')) }]
  assert.deepEqual(sinceReview(saved, current), [])
  const changed = snapshot(diff.replace('send())', 'send(1))'))
  assert.deepEqual(sinceReview(saved, changed).map(group => group.key), ['net'])
})
