const tabKey = id => 'open-' + id
let pending = Promise.resolve()

function changeDock(id, close = false) {
  pending = pending.then(async () => {
    const key = tabKey(id)
    const open = !close && (await chrome.storage.session.get(key))[key] === false
    if (open) await chrome.storage.session.remove(key)
    else await chrome.storage.session.set({ [key]: false })
    await chrome.tabs.sendMessage(id, { type: 'dock', open }, { frameId: 0 }).catch(() => {})
  }).catch(console.error)
  return pending
}

chrome.action.onClicked.addListener(tab => {
  if (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/\d+\/(?:files|changes)(?:[/?#]|$)/.test(tab.url)) {
    return changeDock(tab.id)
  }
})

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (!sender.tab) return
  const id = sender.tab.id
  if (message === 'host-tab' && sender.url === chrome.runtime.getURL('panel.html')) {
    reply(id)
  } else if (message === 'close-dock' && sender.url === chrome.runtime.getURL('panel.html')) {
    changeDock(id, true)
    reply(true)
  } else if (message === 'dock-state' && sender.frameId === 0) {
    const key = tabKey(id)
    chrome.storage.session.get(key).then(values => reply(values[key] !== false))
    return true
  }
})

chrome.tabs.onRemoved.addListener(id => pending.then(() => chrome.storage.session.remove(tabKey(id))))
