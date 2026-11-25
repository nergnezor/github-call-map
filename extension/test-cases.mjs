export function isTestDirectory(part) {
  return /^(?:__tests__|specs?|(?:unit|integration|android|e2e)?tests?|e2e)$/i.test(part) || /Tests?$/.test(part)
}

export function isTestFile(path) {
  const parts = path.split('/')
  const name = parts.pop().replace(/\.[^.]+$/, '')
  const testName = /(?:^|[._-])(?:tests?|specs?)(?:$|[._-])/i
  return testName.test(name) || /(?:Tests?|Spec)$/.test(name) || /^Test[A-Z]/.test(name)
    || parts.some(isTestDirectory)
}

function caseName(source, code, language) {
  const prefix = language === 'c' ? /^\s*(?:TEST_CASE(?:_FIXTURE)?|SCENARIO)\s*\(/ :
    language === 'js' ? /^\s*(?:test|it)(?:\.concurrent)?\s*\(/ : null
  if (!prefix?.test(code)) return
  const title = source.match(/^\s*\w+(?:\.concurrent)?\s*\(\s*(?:[\w:<>]+\s*,\s*)?(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)')/)
  return title?.[1] ?? title?.[2]
}

export function trackTestCases(path, language, cases) {
  let active, depth, opened, headingIndent, annotated, annotationLine
  let mockDepth = 0
  function begin(name) {
    active = { name, path, targets: new Map(), checks: [], evidence: [], patchLines: new Set() }
    cases.push(active)
    depth = 0
    opened = false
  }
  return {
    hunk(heading) {
      const name = caseName(heading, heading, language)
      if (!name) active = null
      else if (active?.name !== name) begin(name)
      mockDepth = 0
      depth = null
      headingIndent = heading.search(/\S/)
      annotated = false
      annotationLine = undefined
    },
    removed(index) {
      active?.patchLines.add(index)
    },
    line(source, code, number, added, calls, index) {
      let name = caseName(source, code, language)
      const attribute = (language === 'rust' && /^\s*#\[(?:\w+::)?test\]/.test(code))
        || (language === 'kotlin' && /^\s*@Test\b/.test(code))
      if (attribute || annotated) {
        if (language === 'rust') name = code.match(/\bfn\s+(\w+)/)?.[1]
        else if (/\bfun\s/.test(code)) {
          const fn = source.match(/\bfun\s+(?:`([^`]+)`|(\w+))/)
          name = fn?.[1] ?? fn?.[2]
        }
      }
      if (name) {
        begin(name)
        if (annotationLine !== undefined) active.patchLines.add(annotationLine)
      }
      annotated = attribute && !name
      annotationLine = annotated && added ? index : undefined
      if (!active) return
      if (added) active.patchLines.add(index)
      const mock = code.search(/\b(?:NAMED_)?(?:REQUIRE|ALLOW|FORBID|EXPECT|ON)_CALL\s*\(/)
      if (mockDepth || mock >= 0) {
        const argumentsCode = mockDepth ? code : code.slice(mock)
        mockDepth = Math.max(0, mockDepth + (argumentsCode.match(/\(/g)?.length ?? 0) - (argumentsCode.match(/\)/g)?.length ?? 0))
      } else {
        for (const target of calls) {
          if (!active.targets.has(target)) active.targets.set(target, number)
        }
      }
      if (/\b(?:CHECK(?:_\w+)?|REQUIRE(?:_(?!CALL\b)\w+)?|EXPECT_\w+|ASSERT_\w+|assert\w*|expect)\s*!?\s*\(/.test(code)) {
        const words = new Set(code.match(/[a-zA-Z_$][\w$]*/g))
        active.evidence.push({ words, code: source.trim(), number, language })
        active.checks.push(source.trim())
      }
      if (depth === null) {
        if (/^\s*}\s*\)?;?\s*$/.test(code) && code.search(/\S/) <= headingIndent) active = null
      } else {
        const js = language === 'js'
        const opens = code.match(js ? /\(/g : /{/g)?.length ?? 0
        depth += opens - (code.match(js ? /\)/g : /}/g)?.length ?? 0)
        opened ||= opens > 0
        if ((opened && depth <= 0) || (language === 'kotlin' && name && !opened && code.includes('='))) active = null
      }
    },
  }
}
