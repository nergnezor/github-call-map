import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../extension/graph.mjs'

function graph(path, ...lines) {
  return buildGraph(['diff --git a/' + path + ' b/' + path, '--- a/' + path, '+++ b/' + path, ...lines].join('\n'))
}

test('links two changed cases to their own call lines and assertion previews', () => {
  const { nodes } = graph('test_report.cc', '@@ -0,0 +40,10 @@',
    '+TEST_CASE("reconnect starts a fresh interval")', '+{', '+  report(4000);', '+  report(5000);',
    '+  CHECK(rate == 16);', '+}', '+TEST_CASE_FIXTURE(Fixture, "no reports while offline") {',
    '+  report(0);', '+  CHECK(reports.empty());', '+}')
  const links = nodes.get('c:report').tests
  assert.deepEqual(links.map(({name, path, number, checks}) => [name, path, number, checks]), [
    ['reconnect starts a fresh interval','test_report.cc',42,['CHECK(rate == 16);']],
    ['no reports while offline','test_report.cc',47,['CHECK(reports.empty());']],
  ])
})

test('a changed assertion links the visible context call and leaves adjacent untouched cases and helpers out', () => {
  const { nodes } = graph('report.test.js', '@@ -8,6 +8,6 @@',
    ' test("old", () => { untouched() })', ' test("new rate", () => {', '   report()',
    '-  expect(rate).toBe(8)', '+  expect(rate).toBe(16)', ' })', '+helper()')
  assert.equal(nodes.get('js:untouched').tests, undefined)
  assert.equal(nodes.get('js:helper').tests, undefined)
  assert.equal(nodes.get('js:report').tests[0].number, 10)
})

test('uses a named hunk heading and skips mock expectations and deleted calls', () => {
  const { nodes } = graph('tests/test_ping.cc', '@@ -87,4 +90,4 @@ TEST_CASE("a reconnect starts reporting")',
    '     REQUIRE_CALL(*env, mockPing());', '-    removed();', '+    ping();', '     CHECK(sent == 1);', ' }')
  assert.equal(nodes.get('c:mockPing').tests, undefined)
  assert.deepEqual(nodes.get('c:ping').tests, [{name:'a reconnect starts reporting',path:'tests/test_ping.cc',number:91,checks:['CHECK(sent == 1);']}])
})

test('a deletion inside an annotated test links only its remaining direct calls', () => {
  const { nodes } = graph('tests/metrics.rs', '@@ -1,7 +1,6 @@',
    ' #[test]', ' fn reconnects() {', '   report();', '-  removed();', '   assert_eq!(rate, 16);', ' }', '+fn helper() { other() }')
  assert.equal(nodes.get('rust:report').tests[0].name, 'reconnects')
  assert.equal(nodes.get('rust:other').tests, undefined)
})

test('a nested suite hunk ends before changes outside its test', () => {
  const { nodes } = graph('net.spec.js', "@@ -8,3 +8,4 @@   it('sends', () => {",
    '     send()', '   })', '+  outside()')
  assert.equal(nodes.get('js:send').tests, undefined)
  assert.equal(nodes.get('js:outside').tests, undefined)
})

test('a Kotlin test can declare its name on the annotation line', () => {
  const { nodes } = graph('SocketTest.kt', '@@ -0,0 +3,3 @@',
    '+  @Test fun `reconnects the socket`() {', '+    assertTrue(connect())', '+  }')
  assert.equal(nodes.get('kotlin:connect').tests[0].name, 'reconnects the socket')
})

test('a multi-line mock expectation does not create a direct test link', () => {
  const { nodes } = graph('test_call.cc', '@@ -0,0 +1,6 @@', '+TEST_CASE("dispatch") {',
    '+  REQUIRE_CALL(', '+    *env,', '+    transmit());', '+  dispatch();', '+}')
  assert.equal(nodes.get('c:transmit').tests, undefined)
  assert.equal(nodes.get('c:dispatch').tests.length, 1)
})

test('an expanded test includes every assertion visible in the patch', () => {
  const checks = [1, 2, 3, 4].map(n => 'CHECK(value == ' + n + ');')
  const { nodes } = graph('tests/test_value.cc', '@@ -0,0 +1,7 @@', '+TEST_CASE("values") {', '+ readValue();',
    ...checks.map(check => '+ ' + check), '+}')
  assert.deepEqual(nodes.get('c:readValue').tests[0].checks, checks)
})
