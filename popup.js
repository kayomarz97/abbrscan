document.addEventListener('DOMContentLoaded', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
  if (!tab) return

  // Guard: content script cannot run on chrome://, about:, extension pages, etc.
  function isInjectable(url) {
    if (!url) return false
    return !url.startsWith('chrome://') &&
           !url.startsWith('chrome-extension://') &&
           !url.startsWith('about:') &&
           !url.startsWith('edge://') &&
           !url.startsWith('moz-extension://')
  }

  // Suppress unchecked lastError on tabs where content script may not be present
  function sendToTab(tabId, message) {
    chrome.tabs.sendMessage(tabId, message, () => void chrome.runtime.lastError)
  }

  const injectable = isInjectable(tab.url)

  chrome.runtime.sendMessage({ action: 'getCount', tabId: tab.id }, (response) => {
    void chrome.runtime.lastError
    const count = response?.count ?? 0
    document.getElementById('abbr-count').textContent =
      count === 0 ? '—' : count
    document.getElementById('count-label').textContent =
      !injectable        ? 'not supported on this page' :
      count === 0        ? 'not yet scanned' :
      count === 1        ? 'abbreviation found' : 'abbreviations found'
  })

  const scanBtn       = document.getElementById('scan-btn')
  const sidebarBtn    = document.getElementById('show-sidebar-btn')

  if (!injectable) {
    scanBtn.disabled    = true
    sidebarBtn.disabled = true
    scanBtn.style.opacity    = '0.4'
    sidebarBtn.style.opacity = '0.4'
  }

  scanBtn.addEventListener('click', () => {
    if (!injectable) return
    sendToTab(tab.id, { action: 'rescan' })
    window.close()
  })

  sidebarBtn.addEventListener('click', () => {
    if (!injectable) return
    sendToTab(tab.id, { action: 'showSidebar' })
    window.close()
  })

  let hostname
  try { hostname = new URL(tab.url).hostname } catch (e) { hostname = '' }
  const storageKey = `abbrscan_enabled_${hostname}`
  const toggleEl   = document.getElementById('enable-toggle')

  chrome.storage.local.get(storageKey, (data) => {
    toggleEl.checked = data[storageKey] !== false
  })

  toggleEl.addEventListener('change', () => {
    sendToTab(tab.id, { action: toggleEl.checked ? 'rescan' : 'disable' })
  })
})
