// Redirect local PDF files to AbbrScan's bundled PDF.js viewer
// Uses declarativeNetRequest to intercept at the network level before
// Chrome's native PDF viewer can claim the page.
function registerPdfRedirectRule() {
  const viewerUrl = chrome.runtime.getURL('pdfjs/web/viewer.html')
  chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'redirect',
        redirect: { regexSubstitution: viewerUrl + '?file=\\0' }
      },
      condition: {
        regexFilter: '^file://.*\\.pdf(\\?.*)?$',
        resourceTypes: ['main_frame']
      }
    }]
  }, () => {
    if (chrome.runtime.lastError) {
      console.debug('AbbrScan: PDF redirect rule failed:', chrome.runtime.lastError.message)
    }
  })
}

chrome.runtime.onInstalled.addListener(() => {
  registerPdfRedirectRule()
})

chrome.runtime.onStartup.addListener(() => {
  registerPdfRedirectRule()
})

// Safely set badge — tab may have closed before the call completes
function safeBadge(tabId, text, color) {
  chrome.action.setBadgeText({ tabId, text }).catch(() => {})
  if (color) chrome.action.setBadgeBackgroundColor({ tabId, color }).catch(() => {})
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const tabId = message.tabId || sender.tab?.id
  if (!tabId) return

  if (message.action === 'updateBadge') {
    chrome.storage.session.set({ [`badge_${tabId}`]: message.count })
    safeBadge(tabId, message.count > 0 ? String(message.count) : '', '#1e40af')
  }

  if (message.action === 'clearBadge') {
    chrome.storage.session.remove(`badge_${tabId}`)
    safeBadge(tabId, '')
  }

  if (message.action === 'getCount') {
    chrome.storage.session.get(`badge_${tabId}`, (data) => {
      sendResponse({ count: data[`badge_${tabId}`] ?? 0 })
    })
    return true
  }
})

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status === 'loading') {
    chrome.storage.session.remove(`badge_${tabId}`)
    safeBadge(tabId, '')
  }
})

chrome.tabs.onRemoved.addListener((tabId) => {
  chrome.storage.session.remove(`badge_${tabId}`)
})
