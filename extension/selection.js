chrome.runtime.onConnect.addListener(port => {
  if (port.name !== 'diff-selection') return
  const codeSelector = '[data-diff-text-inner], .diff-text-inner, .blob-code-inner'

  const cellSelector = 'td[role="gridcell"], td[data-diff-cell], td[data-line-anchor]'
  let canGoBack = false
  port.onMessage?.addListener(message => {
    if ('canGoBack' in message) canGoBack = message.canGoBack
  })
  let selectionBeforeFocus

  function send(message) {
    if (chrome.runtime?.id) port.postMessage(message)
    else stop()
  }

  function report(event) {
    const selection = document.getSelection()
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null
    const clicked = event?.type === 'click'
    if (event?.type === 'selectionchange' && range === selectionBeforeFocus) return
    if (clicked) selectionBeforeFocus = range
    let point = range
    if (clicked) {
      const caret = document.caretRangeFromPoint(event.clientX, event.clientY)
      if (!caret || !range || range.collapsed || !range.isPointInRange(caret.startContainer, caret.startOffset)) point = caret
    }
    const node = point?.startContainer
    const element = node?.nodeType === Node.ELEMENT_NODE ? node : node?.parentElement
    const code = element?.closest(codeSelector)
    if (!code || !code.contains(point.endContainer) || (clicked && !code.contains(event.target))) {
      if (clicked) reportFocus(event)
      return
    }

    let name = ''
    if (!point.collapsed) {
      name = point.toString().trim()
      if (!/^[a-zA-Z_$][\w$]*$/.test(name)) return
    } else if (node.nodeType === Node.TEXT_NODE) {
      const prefix = point.cloneRange()
      prefix.setStart(code, 0)
      const offset = prefix.toString().length
      const text = code.textContent
      const before = text.slice(0, offset).match(/[\w$]+$/)?.[0] ?? ''
      const after = text.slice(offset).match(/^[\w$]+/)?.[0] ?? ''
      name = before + after
    }
    const cell = code.closest('td')
    const file = cell?.closest('[id^="diff-"][role="region"]')
    const anchor = file && cell.dataset.diffSide && cell.dataset.lineNumber
      ? file.id + (cell.dataset.diffSide === 'left' ? 'L' : 'R') + cell.dataset.lineNumber
      : cell?.dataset.lineAnchor || cell?.id || cell?.previousElementSibling?.id
    send({ name, anchor, url: location.href, clicked })
  }

  function reportFocus({ target }) {
    let cell = target.closest?.(cellSelector)
    if (!cell) return
    if (cell.dataset.diffCell === 'empty') {
      cell = cell.closest('tr').querySelector('[data-diff-cell="text"][data-diff-side="right"]')
    } else if (cell.matches('[data-diff-cell="line-number"], .diff-line-number')) {
      do {
        cell = cell.nextElementSibling
      } while (cell && !cell.matches('[data-diff-cell="text"], [data-line-anchor]'))
    }
    if (!cell || cell.dataset.diffCell === 'hunk') return
    const file = cell.closest('[id^="diff-"][role="region"]')
    const { diffSide, lineNumber, lineAnchor } = cell.dataset
    const anchor = file && diffSide && lineNumber
      ? file.id + (diffSide === 'left' ? 'L' : 'R') + lineNumber
      : lineAnchor
    if (!anchor) return
    const selection = document.getSelection()
    selectionBeforeFocus = selection?.rangeCount ? selection.getRangeAt(0) : null
    send({ anchor, url: location.href })
  }

  let lastViewed, viewedPage, viewedTimer, embedded
  const files = new Map()
  const view = document.defaultView
  const root = document.documentElement
  const preference = view.matchMedia?.('(prefers-color-scheme: dark)')
  let lastTheme
  function reportTheme() {
    const mode = root.getAttribute('data-color-mode')
    const style = view.getComputedStyle?.(root)
    const scheme = mode === 'dark' || mode === 'light' ? mode
      : preference?.matches ? 'dark' : 'light'
    const colors = {}
    for (const [key, token] of Object.entries({
      surface: '--bgColor-default', text: '--fgColor-default', muted: '--fgColor-muted',
      line: '--borderColor-default', accent: '--fgColor-accent', tint: '--bgColor-accent-muted',
      plus: '--fgColor-success', minus: '--fgColor-danger',
    })) {
      const value = style?.getPropertyValue(token).trim()
      if (value) colors[key] = value
    }
    const theme = { scheme, colors }
    const signature = JSON.stringify([location.href.split('#')[0], theme])
    if (signature !== lastTheme) send({ theme, url: location.href })
    lastTheme = signature
  }
  preference?.addEventListener('change', reportTheme)
  view.addEventListener?.('load', reportTheme)
  function reportViewed() {
    viewedTimer = undefined
    reportTheme()
    const page = location.href.split('#')[0]
    if (viewedPage !== page) files.clear()
    viewedPage = page
    const data = document.querySelector('script[data-target="react-app.embeddedData"]')
    if (data && data !== embedded) {
      embedded = data
      try {
        const summaries = JSON.parse(data.textContent).payload?.diffSummaries
        if (Array.isArray(summaries)) files.clear()
        for (const file of summaries ?? []) {
          if (typeof file.path === 'string' && typeof file.markedAsViewed === 'boolean') files.set('path:' + file.path, file.markedAsViewed)
        }
      } catch {
        // GitHub can insert the script before its JSON text.
        embedded = null
      }
    }
    for (const item of document.querySelectorAll('[id^="file-tree-item-diff-"], [id^="diff-"][data-file-user-viewed]')) {
      const id = item.id.replace(/^file-tree-item-/, '')
      if (/^diff-[a-f0-9]{64}$/.test(id)) files.set('#' + id, item.hasAttribute('data-file-user-viewed'))
    }
    for (const button of document.querySelectorAll('[aria-pressed][aria-label="Viewed"], [aria-pressed][aria-label="Not Viewed"], input.js-reviewed-checkbox')) {
      const file = button.closest('[role="region"][id^="diff-"], .file[id^="diff-"]') ?? button.closest('[id^="diff-"]')
      if (!file || !/^diff-[a-f0-9]{64}$/.test(file.id)) continue
      files.set('#' + file.id, button.matches('input') ? button.checked : button.getAttribute('aria-pressed') === 'true')
    }
    const viewed = [...files]
    const signature = JSON.stringify([page, viewed])
    if (signature !== lastViewed) send({ viewed, url: location.href })
    lastViewed = signature
  }
  function scheduleViewed() {
    viewedTimer ??= view.setTimeout(reportViewed, 80)
  }
  const observer = new view.MutationObserver(scheduleViewed)
  observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true,
    attributeFilter: ['aria-pressed', 'checked', 'data-file-user-viewed', 'data-color-mode', 'data-light-theme', 'data-dark-theme'] })
  document.addEventListener('change', scheduleViewed, true)
  reportViewed()

  function backKey(event) {
    if (!chrome.runtime?.id || !canGoBack || event.key !== 'ArrowLeft' || !event.altKey || event.ctrlKey || event.shiftKey || event.metaKey) return
    event.preventDefault()
    event.stopPropagation()
    send({ goBack: true, url: location.href })
  }
  document.addEventListener('keydown', backKey, true)
  document.addEventListener('focusin', reportFocus, true)
  document.addEventListener('click', report, true)
  document.addEventListener('selectionchange', report)
  function stop() {
    observer.disconnect()
    preference?.removeEventListener('change', reportTheme)
    view.removeEventListener?.('load', reportTheme)
    view.clearTimeout(viewedTimer)
    document.removeEventListener('change', scheduleViewed, true)
    document.removeEventListener('keydown', backKey, true)
    document.removeEventListener('focusin', reportFocus, true)
    document.removeEventListener('click', report, true)
    document.removeEventListener('selectionchange', report)
  }
  port.onDisconnect.addListener(stop)
  const active = document.activeElement
  if (active?.closest(cellSelector) && !active.contains(document.getSelection()?.focusNode)) {
    reportFocus({ target: active })
  } else {
    report()
  }
})
