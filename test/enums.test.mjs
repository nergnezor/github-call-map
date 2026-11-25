import test from 'node:test'
import assert from 'node:assert/strict'
import { buildGraph } from '../extension/graph.mjs'

function file(path, ...lines) {
  return ['diff --git a/' + path + ' b/' + path, '--- a/' + path, '+++ b/' + path,
    '@@ -1 +1 @@', ...lines].join('\n')
}

test('a C typedef enum has all its members and only real new-side references', () => {
  const diff = [file('use.c', '+void run(void) { send(READY, READY); }', ' case WAITING: break;',
    '-record(READY);', '+// READY', '+log("WAITING");', '+other->READY = 1;'),
    file('mode.h', '+typedef enum', '+{', '+    READY = FLAG(1, 2),', '+    WAITING,', '+    UNUSED', '+} Mode;')].join('\n')
  const enums = buildGraph(diff).enums
  const mode = enums.get('mode.h').get(1)
  assert.equal(enums.get('mode.h').get(6), mode)
  assert.equal(mode.name, 'Mode')
  assert.deepEqual(mode.members.map(m => m.name), ['READY', 'WAITING', 'UNUSED'])
  assert.deepEqual(mode.members.map(m => m.uses.map(s => [s.path,s.number,s.added])),
    [[['use.c', 1, true]], [['use.c', 2, false]], []])
})

test('scoped members with the same name only match their qualified uses', () => {
  const enums = buildGraph(file('m.cpp', '+enum class A : int { Idle, Busy };',
    '+enum class B { Idle };', '+use(A::Idle, B::Idle);', '+use(Idle, C::Idle);')).enums
  for (const n of [1, 2]) assert.deepEqual(enums.get('m.cpp').get(n).members[0].uses.map(s => s.number), [3])
})

test('forward declarations and partial hunks never acquire members from another hunk', () => {
  const enums = buildGraph(file('m.h', '+enum State;', '+enum Other {', '+  START,',
    '@@ -50 +60 @@', '+  END', '+};', '+enum Whole { ONLY };')).enums
  assert.equal(enums.get('m.h').get(2), undefined)
  assert.deepEqual(enums.get('m.h').get(62).members.map(m => m.name), ['ONLY'])
})

test('C preprocessor directives leave enum members in each branch visible', () => {
  const enums = buildGraph(file('mode.h', '+enum Mode {', '+#if RADIO', '+  READY = 4,',
    '+#else', '+  WAITING,', '+#endif', '+  OFF', '+};', '+#define DEFAULT_MODE READY')).enums
  const members = enums.get('mode.h').get(1).members
  assert.deepEqual(members.map(m => m.name), ['READY', 'WAITING', 'OFF'])
  assert.deepEqual(members[0].uses.map(s => s.number), [9])
})
