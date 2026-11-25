let dock, highlighted
let renameSheet, renamePage
let retry
let open = false
let receivedState = false

function clearReveal() {
  if (retry !== undefined) clearTimeout(retry)
  retry = undefined
  highlighted?.classList.remove('pr-call-map-line')
  highlighted = null
}

function reveal(hash, waitForLine) {
  clearReveal()
  const match = /^#(diff-[a-f0-9]{64})(?:([LR])(\d+)(?:-[LR]\d+)?)?$/.exec(hash)
  if (!match) return false
  const [, fileId, side, number] = match
  const anchor = fileId + side + number
  const column = side === 'L' ? 'left' : 'right'
  let scrolledFile
  let attempts = 0

  function show() {
    retry = undefined
    const file = document.getElementById(fileId)
    const target = number
      ? file?.querySelector(`[data-diff-cell="text"][data-diff-side="${column}"][data-line-number="${number}"]`)
        ?? document.querySelector(`[data-line-anchor="${anchor}"]:not([data-diff-cell="hunk"])`)
        ?? document.getElementById(anchor)
      : file
    if (target?.checkVisibility()) {
      target.classList.add('pr-call-map-line')
      target.scrollIntoView({ block: 'center', inline: 'nearest' })
      highlighted = target
      return true
    }
    if (waitForLine && number && attempts++ < 50) {
      if (file && file !== scrolledFile) {
        file.scrollIntoView({ block: 'start', inline: 'nearest' })
        scrolledFile = file
      }
      retry = setTimeout(show, 200)
    }
    return false
  }
  return show()
}

function clearRenameSheet() {
  if (!renameSheet) return
  document.adoptedStyleSheets = document.adoptedStyleSheets.filter(sheet => sheet !== renameSheet)
  renameSheet = null
}

function updateDock() {
  if (!chrome.runtime?.id) {
    navigation.removeEventListener('navigatesuccess', updateDock)
    open = false
  }
  if (!open || location.href?.split('#')[0] !== renamePage) clearRenameSheet()
  const inDiff = /^\/[\w.-]+\/[\w.-]+\/pull\/\d+\/(?:files|changes)(?:\/|$)/.test(location.pathname)
  if (!open || !inDiff) {
    clearReveal()
    dock?.remove()
    dock = null
  } else if (!dock?.isConnected) {
    dock?.remove()
    dock = document.createElement('iframe')
    dock.id = 'pr-call-map-panel'
    dock.title = 'PR Call Map'
    dock.src = chrome.runtime.getURL('panel.html')
    document.documentElement.append(dock)
  }
  if (dock) reveal(location.hash, true)
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!chrome.runtime?.id) return
  if (message.type === 'file-order') {
    const data = document.querySelector('script[data-target="react-app.embeddedData"]')
    try {
      const files = data && JSON.parse(data.textContent).payload?.diffSummaries
      reply(Array.isArray(files) ? files.map(file => file.path) : [])
    } catch {
      reply([])
    }
    return
  }
  if (message.type === 'rename-lines') {
    if (dock?.isConnected && sender.url === chrome.runtime.getURL('panel.html') && message.page === location.href.split('#')[0]) {
      clearRenameSheet()
      if (message.selectors) {
        renameSheet = new CSSStyleSheet()
        renameSheet.replaceSync(`${message.selectors} {
          background-color: var(--bgColor-default, Canvas) !important;
          & [data-diff-text-marker] { visibility: hidden }
        }`)
        document.adoptedStyleSheets = [...document.adoptedStyleSheets, renameSheet]
        renamePage = message.page
      }
    }
    reply(true)
    return
  }
  if (message.type === 'reveal') {
    if (!dock?.isConnected || sender.url !== chrome.runtime.getURL('panel.html') || location.href.split('#')[0] !== message.page) {
      reply(false)
      return
    }
    reply(reveal(message.hash, location.hash === message.hash))
    return
  }
  if (message.type !== 'dock') return
  receivedState = true
  open = message.open
  updateDock()
})
navigation.addEventListener('navigatesuccess', updateDock)
chrome.runtime.sendMessage('dock-state').then(saved => {
  if (receivedState) return
  open = saved
  updateDock()
}, error => {
  if (chrome.runtime?.id) console.error(error)
})
