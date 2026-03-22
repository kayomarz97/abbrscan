// --- SECTION A: CONSTANTS AND STATE ---

const ABBRSCAN_SIDEBAR_ID = 'abbrscan-root'
const ABBRSCAN_TOOLTIP_ID = 'abbrscan-tooltip-root'
const ABBRSCAN_BUBBLE_ID  = 'abbrscan-bubble-root'

let abbrMap          = new Map()
let customAbbrMap    = new Map() // user-added, persisted to chrome.storage.local
let highlightSpans   = []
let sidebarHost      = null
let tooltipHost      = null
let selectionBubbleHost = null
let isInitialized    = false
let currentUrl       = window.location.href
let contentWatcher   = null

const ENABLED_KEY = `abbrscan_enabled_${window.location.hostname}`

const EXCLUDE_LIST = new Set([
  'I','A','AN','THE','IN','OF','OR','AND','TO','IS','IT','AS','AT','BY',
  'BE','DO','GO','HE','IF','ME','MY','NO','ON','SO','UP','US','WE',
  'II','III','IV','VI','VII','VIII','IX','XI','XII'
])

// --- SECTION B: ABBREVIATION DETECTION ---

const PATTERN_1 = /\b([A-Za-z][A-Za-z0-9\-']+(?:\s+[A-Za-z0-9\-']+){1,6})\s+\(([A-Za-z][A-Za-z0-9\-]{1,8})\)/g
const PATTERN_2 = /\(([A-Za-z][A-Za-z0-9\-]{1,8})\)\s+([A-Za-z][A-Za-z0-9\-']+(?:\s+[A-Za-z0-9\-']+){1,6})/g

function validateAbbreviation(abbr, phrase, lenient) {
  const words = phrase.trim().split(/\s+/)
  const letters = abbr.split('')
  for (let start = words.length - letters.length; start >= 0; start--) {
    const subset = words.slice(start, start + letters.length)
    if (subset.length !== letters.length) continue
    const matches = subset.every((w, i) => w[0].toLowerCase() === letters[i].toLowerCase())
    if (matches) return subset.join(' ')
  }
  let li = 0
  const matched = []
  for (let wi = 0; wi < words.length && li < letters.length; wi++) {
    if (words[wi][0].toLowerCase() === letters[li].toLowerCase()) {
      matched.push(words[wi]); li++
    } else if (matched.length > 0) {
      matched.push(words[wi])
    }
  }
  if (li === letters.length) return matched.join(' ')
  const alphaNumMatch = abbr.match(/^([A-Za-z]+)(\d+)$/)
  if (alphaNumMatch) {
    const prefix = alphaNumMatch[1], suffix = alphaNumMatch[2]
    if (words.some(w => w === suffix) && (words[0] || '').toLowerCase().startsWith(prefix.toLowerCase()))
      return phrase.trim()
  }
  if (lenient) {
    let matchCount = 0
    for (const letter of letters) {
      if (words.some(w => w[0] && w[0].toLowerCase() === letter.toLowerCase())) matchCount++
    }
    if (matchCount / letters.length >= 0.7) return phrase.trim()
  }
  return null
}

function addToMap(abbreviation, definition, confidence) {
  abbreviation = abbreviation.trim()
  definition   = definition.trim()
  if (!abbreviation || !definition) return
  if (!/^[A-Za-z][A-Za-z0-9\-]{1,8}$/.test(abbreviation)) return
  if (definition.split(/\s+/).length < 2) return
  if (EXCLUDE_LIST.has(abbreviation.toUpperCase())) return
  if (confidence < 3 && (abbreviation.match(/[A-Z]/g) || []).length < 2) return
  const existing = abbrMap.get(abbreviation)
  if (existing && existing.confidence >= confidence) return
  abbrMap.set(abbreviation, { definition, confidence })
}

function scanAbbreviationTables() {
  const allHeadings = document.querySelectorAll('h2,h3,h4,h5,caption,th,dt,p strong')
  for (const heading of allHeadings) {
    if (!/abbreviat|acronym/i.test(heading.textContent)) continue
    const parent     = heading.parentElement
    const containers = parent.querySelectorAll('table,dl,ul,ol')
    const targets    = containers.length > 0 ? containers : [parent]
    for (const el of targets) {
      const tag = el.tagName.toLowerCase()
      if (tag === 'table') {
        for (const row of el.querySelectorAll('tr')) {
          const cells = row.querySelectorAll('td,th')
          if (cells.length >= 2) addToMap(cells[0].textContent, cells[1].textContent, 3)
        }
      }
      if (tag === 'dl') {
        for (const dt of el.querySelectorAll('dt')) {
          const dd = dt.nextElementSibling
          if (dd?.tagName.toLowerCase() === 'dd') addToMap(dt.textContent, dd.textContent, 3)
        }
      }
      if (tag === 'ul' || tag === 'ol') {
        for (const li of el.querySelectorAll('li')) {
          const match = li.textContent.trim().match(/^([^:\-=\t]+?)[\s]*[:\-\—=\t][\s]*(.+)$/)
          if (match) addToMap(match[1].trim(), match[2].trim(), 3)
        }
      }
    }
  }
}

function extractText(root) {
  // PDF.js renders text as absolute-positioned spans inside .textLayer divs.
  // Plain textContent concatenates them without spaces and leaves line-break
  // hyphens intact. Reconstruct with explicit spaces and hyphen merging.
  const textLayers = root.querySelectorAll('.textLayer')
  if (textLayers.length > 0) {
    const parts = []
    for (const layer of textLayers) {
      const pieces = []
      // Sort spans by geometric position (top → left) to handle two-column PDFs
      // where DOM order interleaves columns but visual position is correct.
      // Uses getBoundingClientRect() because PDF.js positions spans via CSS
      // transforms and custom properties, not inline top/left styles.
      const spans = [...layer.querySelectorAll('span')]
      spans.sort((a, b) => {
        const ar = a.getBoundingClientRect()
        const br = b.getBoundingClientRect()
        if (Math.abs(ar.top - br.top) > 2) return ar.top - br.top
        return ar.left - br.left
      })
      for (const span of spans) {
        const t = span.textContent
        if (!t.trim()) continue
        const last = pieces[pieces.length - 1]
        if (last && last.endsWith('-')) {
          if (/^[a-z]/.test(t)) {
            // Lowercase after hyphen → line-break artifact, merge without hyphen
            pieces[pieces.length - 1] = last.slice(0, -1) + t
          } else {
            // Uppercase after hyphen → real hyphen (e.g. LDL-C), keep it + space
            pieces.push(t)
          }
        } else {
          pieces.push(t)
        }
      }
      let text = pieces.join(' ')
        .replace(/\u00ad/g, '')
        // Inline " - " followed by lowercase = line-break hyphen artifact
        .replace(/ - ([a-z])/g, '$1')
        // Collapse multiple spaces
        .replace(/  +/g, ' ')
      if (text.trim()) parts.push(text)
    }
    if (parts.length > 0) return parts.join('\n')
  }
  return root.textContent || ''
}

function scanBodyText() {
  const root = document.querySelector('article')
             || document.querySelector('main')
             || document.body
  const fullText = extractText(root)
  PATTERN_1.lastIndex = 0
  for (const match of fullText.matchAll(PATTERN_1)) {
    const trimmed = validateAbbreviation(match[2], match[1], true)
    if (trimmed) addToMap(match[2], trimmed, 2)
  }
  PATTERN_2.lastIndex = 0
  for (const match of fullText.matchAll(PATTERN_2)) {
    const trimmed = validateAbbreviation(match[1], match[2], false)
    if (trimmed) addToMap(match[1], trimmed, 1)
  }
}

function runScan() {
  abbrMap.clear()
  scanAbbreviationTables()
  scanBodyText()
  // User-added abbreviations always override auto-detected ones (confidence 4)
  for (const [abbr, entry] of customAbbrMap.entries()) abbrMap.set(abbr, entry)
}

// Incremental scan: preserves existing abbreviations (for virtualized PDF pages
// where earlier pages may have been removed from the DOM).
function runIncrementalScan() {
  scanAbbreviationTables()
  scanBodyText()
  for (const [abbr, entry] of customAbbrMap.entries()) abbrMap.set(abbr, entry)
}

// --- SECTION C: SHADOW DOM SETUP ---

function createShadowHost(id, cssString, htmlString) {
  const existing = document.getElementById(id)
  if (existing) existing.remove()
  const host = document.createElement('div')
  host.id = id
  host.style.cssText = 'all:initial;position:fixed;z-index:2147483647;'
  document.body.appendChild(host)
  const shadow  = host.attachShadow({ mode: 'open' })
  const styleEl = document.createElement('style')
  styleEl.textContent = cssString
  shadow.appendChild(styleEl)
  const container = document.createElement('div')
  container.innerHTML = htmlString
  shadow.appendChild(container)
  return { host, shadow, container }
}

// --- SECTION D: SIDEBAR CSS AND HTML CONSTANTS ---

const SIDEBAR_CSS = `
  * { box-sizing:border-box; margin:0; padding:0;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  #abbrscan-sidebar {
    position:fixed; top:80px; right:16px; width:300px; max-height:70vh;
    background:#ffffff; border:1px solid #e2e8f0; border-radius:12px;
    box-shadow:0 4px 24px rgba(0,0,0,0.12); display:flex;
    flex-direction:column; overflow:hidden; font-size:13px; color:#1a202c;
  }
  #sidebar-header {
    background:#1e40af; color:white; padding:12px 16px; cursor:move;
    user-select:none; display:flex; justify-content:space-between;
    align-items:center; flex-shrink:0;
  }
  #sidebar-title    { font-weight:600; font-size:14px; }
  #sidebar-subtitle { font-size:11px; opacity:0.8; margin-top:2px; }
  #sidebar-close {
    background:none; border:none; color:white; font-size:20px;
    cursor:pointer; padding:0 0 0 8px; line-height:1; opacity:0.8;
  }
  #sidebar-close:hover { opacity:1; }
  #sidebar-search-wrap { padding:8px 12px; border-bottom:1px solid #e2e8f0; flex-shrink:0; }
  #abbrscan-search {
    width:100%; padding:7px 10px; border:1px solid #e2e8f0; border-radius:6px;
    font-size:13px; outline:none; color:#1a202c; background:#f8fafc;
  }
  #abbrscan-search:focus { border-color:#1e40af; background:#fff; }
  #sidebar-body { overflow-y:auto; flex:1; scrollbar-width:thin; scrollbar-color:#cbd5e0 transparent; }
  .abbrscan-item { padding:8px 16px; border-bottom:1px solid #f1f5f9; cursor:pointer; display:flex; justify-content:space-between; align-items:flex-start; }
  .abbrscan-item:hover { background:#f8fafc; }
  .abbrscan-item:last-child { border-bottom:none; }
  .abbrscan-item-text { flex:1; min-width:0; }
  .abbrscan-abbr { font-weight:600; color:#1e40af; font-size:13px; display:block; }
  .abbrscan-def  { color:#64748b; font-size:12px; line-height:1.4; display:block; margin-top:2px; }
  .abbrscan-custom-badge { font-size:9px; background:#f0fdf4; color:#16a34a; border:1px solid #bbf7d0; border-radius:3px; padding:1px 4px; margin-left:6px; flex-shrink:0; margin-top:2px; }
  .abbrscan-delete { background:none; border:none; color:#cbd5e0; font-size:14px; cursor:pointer; padding:0 0 0 4px; line-height:1; flex-shrink:0; }
  .abbrscan-delete:hover { color:#ef4444; }
  .abbrscan-edit { background:none; border:none; color:#94a3b8; font-size:13px; cursor:pointer; padding:0 0 0 4px; line-height:1; flex-shrink:0; }
  .abbrscan-edit:hover { color:#1e40af; }
  .abbrscan-edit-form { width:100%; padding:8px 16px; border-bottom:1px solid #f1f5f9; }
  .abbrscan-edit-form input {
    width:100%; padding:5px 8px; border:1px solid #e2e8f0; border-radius:6px;
    font-size:13px; outline:none; color:#1a202c; background:#f8fafc; margin-bottom:6px;
  }
  .abbrscan-edit-form input:focus { border-color:#1e40af; background:#fff; }
  .abbrscan-edit-actions { display:flex; gap:6px; justify-content:flex-end; }
  .abbrscan-edit-actions button {
    padding:4px 10px; border:none; border-radius:4px; font-size:11px; cursor:pointer;
  }
  .abbrscan-edit-save { background:#1e40af; color:white; }
  .abbrscan-edit-save:hover { background:#1d3a9e; }
  .abbrscan-edit-cancel { background:#e2e8f0; color:#475569; }
  .abbrscan-edit-cancel:hover { background:#cbd5e0; }
  #sidebar-empty { padding:24px 16px; text-align:center; color:#94a3b8; font-size:12px; line-height:1.6; }
  #scan-now-btn {
    margin-top:12px; padding:8px 20px; background:#1e40af; color:white;
    border:none; border-radius:6px; font-size:13px; cursor:pointer;
  }
  #scan-now-btn:hover { background:#1d3a9e; }
`

const SIDEBAR_HTML = `
  <div id="abbrscan-sidebar">
    <div id="sidebar-header">
      <div>
        <div id="sidebar-title">AbbrScan</div>
        <div id="sidebar-subtitle">Scanning...</div>
      </div>
      <button id="sidebar-close">\u00d7</button>
    </div>
    <div id="sidebar-search-wrap">
      <input type="text" id="abbrscan-search" placeholder="Search abbreviations...">
    </div>
    <div id="sidebar-body">
      <div id="sidebar-empty">Scanning page for abbreviations...</div>
    </div>
  </div>
`

// --- SECTION E: SIDEBAR INJECTION AND POPULATION ---

function injectSidebar() {
  const { host, shadow } = createShadowHost(ABBRSCAN_SIDEBAR_ID, SIDEBAR_CSS, SIDEBAR_HTML)
  sidebarHost = host

  const sidebar  = shadow.getElementById('abbrscan-sidebar')
  const closeBtn = shadow.getElementById('sidebar-close')
  const searchEl = shadow.getElementById('abbrscan-search')
  const header   = shadow.getElementById('sidebar-header')

  closeBtn.addEventListener('click', () => { sidebarHost.remove(); sidebarHost = null })

  searchEl.addEventListener('input', () => {
    const q = searchEl.value.toLowerCase()
    shadow.querySelectorAll('.abbrscan-item').forEach(item => {
      const abbr = item.querySelector('.abbrscan-abbr')?.textContent.toLowerCase() || ''
      const def  = item.querySelector('.abbrscan-def')?.textContent.toLowerCase()  || ''
      item.style.display = (abbr.includes(q) || def.includes(q)) ? '' : 'none'
    })
  })

  let isDragging = false, dragStartX = 0, dragStartY = 0, startTop = 0, startRight = 0
  header.addEventListener('mousedown', (e) => {
    e.preventDefault()
    isDragging = true
    dragStartX = e.clientX; dragStartY = e.clientY
    startTop   = parseFloat(sidebar.style.top)   || 80
    startRight = parseFloat(sidebar.style.right) || 16
    const onMove = (e) => {
      if (!isDragging) return
      const vw = window.innerWidth,  vh = window.innerHeight
      const sw = sidebar.offsetWidth, sh = sidebar.offsetHeight
      let newTop   = Math.max(0, Math.min(startTop   + (e.clientY - dragStartY), vh - sh))
      let newRight = Math.max(0, Math.min(startRight - (e.clientX - dragStartX), vw - sw))
      sidebar.style.top   = newTop   + 'px'
      sidebar.style.right = newRight + 'px'
    }
    const onUp = () => {
      isDragging = false
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup',   onUp)
      chrome.storage.local.set({ abbrscanPos: {
        top:   parseFloat(sidebar.style.top)   || 80,
        right: parseFloat(sidebar.style.right) || 16
      }})
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup',   onUp)
  })

  chrome.storage.local.get('abbrscanPos', (data) => {
    if (data.abbrscanPos) {
      sidebar.style.top   = data.abbrscanPos.top   + 'px'
      sidebar.style.right = data.abbrscanPos.right + 'px'
    }
  })
}

function populateSidebar() {
  if (!sidebarHost) return
  const shadow   = sidebarHost.shadowRoot
  const body     = shadow.getElementById('sidebar-body')
  const subtitle = shadow.getElementById('sidebar-subtitle')
  const sorted   = [...abbrMap.keys()].sort()

  if (sorted.length === 0) {
    body.innerHTML = contentWatcher !== null
      ? '<div id="sidebar-empty">Waiting for page content to load\u2026<br><small style="opacity:0.7">AbbrScan will update automatically.</small></div>'
      : '<div id="sidebar-empty">No abbreviations detected on this page.</div>'
    subtitle.textContent = '0 abbreviations found'
    return
  }

  subtitle.textContent = `${sorted.length} abbreviation${sorted.length === 1 ? '' : 's'} found`

  const frag = document.createDocumentFragment()
  for (const abbr of sorted) {
    const entry    = abbrMap.get(abbr)
    const isCustom = customAbbrMap.has(abbr)
    const item     = document.createElement('div')
    item.className = 'abbrscan-item'

    const textWrap = document.createElement('div')
    textWrap.className = 'abbrscan-item-text'

    const abbrLine = document.createElement('div')
    abbrLine.style.display = 'flex'
    abbrLine.style.alignItems = 'center'

    const abbrSpan = document.createElement('span')
    abbrSpan.className   = 'abbrscan-abbr'
    abbrSpan.textContent = abbr
    abbrLine.appendChild(abbrSpan)

    if (isCustom) {
      const badge = document.createElement('span')
      badge.className   = 'abbrscan-custom-badge'
      badge.textContent = 'custom'
      abbrLine.appendChild(badge)
    }
    textWrap.appendChild(abbrLine)

    const defSpan = document.createElement('span')
    defSpan.className   = 'abbrscan-def'
    defSpan.textContent = entry.definition
    textWrap.appendChild(defSpan)

    item.appendChild(textWrap)

    const editBtn = document.createElement('button')
    editBtn.className   = 'abbrscan-edit'
    editBtn.textContent = '\u270E'
    editBtn.title       = 'Edit abbreviation'
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation()
      const editForm = document.createElement('div')
      editForm.className = 'abbrscan-edit-form'

      const abbrInput = document.createElement('input')
      abbrInput.type        = 'text'
      abbrInput.value       = abbr
      abbrInput.placeholder = 'Abbreviation'

      const defInput = document.createElement('input')
      defInput.type        = 'text'
      defInput.value       = entry.definition
      defInput.placeholder = 'Definition'

      const actions = document.createElement('div')
      actions.className = 'abbrscan-edit-actions'

      const saveBtn = document.createElement('button')
      saveBtn.className   = 'abbrscan-edit-save'
      saveBtn.textContent = 'Save'
      saveBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        const newAbbr = abbrInput.value.trim()
        const newDef  = defInput.value.trim()
        if (!newAbbr || !newDef) return
        if (newAbbr !== abbr) {
          customAbbrMap.delete(abbr)
          abbrMap.delete(abbr)
        }
        addCustomAbbreviation(newAbbr, newDef)
        removeHighlights()
        runScan()
        highlightAbbreviations()
        populateSidebar()
        chrome.runtime.sendMessage({ action: 'updateBadge', count: abbrMap.size })
      })

      const cancelBtn = document.createElement('button')
      cancelBtn.className   = 'abbrscan-edit-cancel'
      cancelBtn.textContent = 'Cancel'
      cancelBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        editForm.replaceWith(item)
      })

      actions.appendChild(saveBtn)
      actions.appendChild(cancelBtn)
      editForm.appendChild(abbrInput)
      editForm.appendChild(defInput)
      editForm.appendChild(actions)

      item.replaceWith(editForm)
      abbrInput.focus()
    })
    item.appendChild(editBtn)

    if (isCustom) {
      const delBtn = document.createElement('button')
      delBtn.className   = 'abbrscan-delete'
      delBtn.textContent = '\u00d7'
      delBtn.title       = 'Remove custom abbreviation'
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation()
        customAbbrMap.delete(abbr)
        saveCustomAbbreviations()
        removeHighlights()
        runScan()
        highlightAbbreviations()
        populateSidebar()
        chrome.runtime.sendMessage({ action: 'updateBadge', count: abbrMap.size })
      })
      item.appendChild(delBtn)
    }

    textWrap.addEventListener('click', () => {
      const target = document.querySelector(`.abbrscan-highlight[data-abbr="${CSS.escape(abbr)}"]`)
      if (target) target.scrollIntoView({ behavior:'smooth', block:'center' })
    })

    frag.appendChild(item)
  }

  body.innerHTML = ''
  body.appendChild(frag)
}

// --- SECTION F: TOOLTIP ---

const TOOLTIP_CSS = `
  * { box-sizing:border-box; margin:0; padding:0;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  #abbrscan-tooltip {
    position:fixed; background:#1e293b; color:#f1f5f9; padding:8px 12px;
    border-radius:8px; font-size:12px; max-width:240px; line-height:1.5;
    pointer-events:none; opacity:0; transition:opacity 0.15s;
    white-space:normal; word-break:break-word;
  }
  #abbrscan-tooltip.visible { opacity:1; }
  #abbrscan-tooltip strong  { color:#93c5fd; display:block; margin-bottom:2px; font-size:13px; }
`

function injectTooltip() {
  const { host } = createShadowHost(
    ABBRSCAN_TOOLTIP_ID, TOOLTIP_CSS, '<div id="abbrscan-tooltip"></div>'
  )
  tooltipHost = host
}

function showTooltip(e, abbr, definition) {
  if (!tooltipHost) return
  const tooltip = tooltipHost.shadowRoot.getElementById('abbrscan-tooltip')
  tooltip.textContent = ''
  const strong = document.createElement('strong')
  strong.textContent = abbr
  tooltip.appendChild(strong)
  tooltip.appendChild(document.createTextNode(definition))

  const tipW = 240, tipH = 60
  let x = Math.max(8, Math.min(e.clientX - tipW / 2, window.innerWidth  - tipW - 8))
  let y = e.clientY - tipH - 12
  if (y < 8) y = e.clientY + 20
  y = Math.max(8, Math.min(y, window.innerHeight - tipH - 8))
  tooltipHost.style.left = x + 'px'
  tooltipHost.style.top  = y + 'px'
  tooltip.classList.add('visible')
}

function hideTooltip() {
  if (!tooltipHost) return
  tooltipHost.shadowRoot.getElementById('abbrscan-tooltip').classList.remove('visible')
}

// --- SECTION G: DOM HIGHLIGHTING ---

function highlightAbbreviations() {
  if (abbrMap.size === 0) return
  const sortedAbbrs   = [...abbrMap.keys()].sort((a, b) => b.length - a.length)
  const escapedAbbrs  = sortedAbbrs.map(a => a.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  const combinedRegex = new RegExp('\\b(' + escapedAbbrs.join('|') + ')\\b', 'g')
  const root = document.querySelector('article') || document.querySelector('main') || document.body

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent) return NodeFilter.FILTER_REJECT
      const tag = parent.tagName?.toLowerCase()
      if (['script','style','code','pre','textarea','input','select'].includes(tag))
        return NodeFilter.FILTER_REJECT
      if (parent.closest(`#${ABBRSCAN_SIDEBAR_ID}, #${ABBRSCAN_TOOLTIP_ID}, #${ABBRSCAN_BUBBLE_ID}`))
        return NodeFilter.FILTER_REJECT
      if (parent.classList?.contains('abbrscan-highlight'))
        return NodeFilter.FILTER_REJECT
      if (!node.textContent.trim())
        return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })

  const textNodes = []
  let node
  while ((node = walker.nextNode())) textNodes.push(node)

  for (const textNode of textNodes) {
    try {
      const text = textNode.textContent
      combinedRegex.lastIndex = 0
      if (!combinedRegex.test(text)) continue
      combinedRegex.lastIndex = 0
      const frag = document.createDocumentFragment()
      let lastIndex = 0, match
      while ((match = combinedRegex.exec(text)) !== null) {
        const abbr  = match[1]
        const entry = abbrMap.get(abbr)
        if (!entry) continue
        if (match.index > lastIndex)
          frag.appendChild(document.createTextNode(text.slice(lastIndex, match.index)))
        const span = document.createElement('span')
        span.className    = 'abbrscan-highlight'
        span.dataset.abbr = abbr
        span.textContent  = abbr
        span.style.cssText = 'border-bottom:2px solid #f59e0b;cursor:help;background:transparent;transition:border-bottom-color 0.15s;'
        span.addEventListener('mouseover', (e) => showTooltip(e, abbr, entry.definition))
        span.addEventListener('mouseout',  hideTooltip)
        frag.appendChild(span)
        highlightSpans.push(span)
        lastIndex = match.index + abbr.length
      }
      combinedRegex.lastIndex = 0
      if (lastIndex < text.length)
        frag.appendChild(document.createTextNode(text.slice(lastIndex)))
      if (frag.childNodes.length > 0 && textNode.parentNode)
        textNode.parentNode.replaceChild(frag, textNode)
    } catch (err) { console.debug('AbbrScan: highlight error', err) }
  }
}

// --- SECTION H: CLEANUP ---

function removeHighlights() {
  for (const span of highlightSpans) {
    try {
      if (span.parentNode)
        span.parentNode.replaceChild(document.createTextNode(span.textContent), span)
    } catch (e) { console.debug('AbbrScan: unhighlight error', e) }
  }
  highlightSpans = []
}

function cleanup() {
  stopContentWatcher()
  removeHighlights()
  hideSelectionBubble()
  if (sidebarHost) { sidebarHost.remove(); sidebarHost = null }
  if (tooltipHost) { tooltipHost.remove(); tooltipHost = null }
  abbrMap.clear()
  isInitialized = false
  chrome.runtime.sendMessage({ action: 'clearBadge' })
}

// --- SECTION I: PAPER DETECTION AND LAZY CONTENT WATCHER ---

function isLazyContentPage() {
  const url = window.location.href.toLowerCase()
  return url.includes('/epdf/') || url.includes('/pdf/') ||
         url.includes('pdfviewer') || url.includes('viewer.html')
}

function stopContentWatcher() {
  if (contentWatcher) { contentWatcher.disconnect(); contentWatcher = null }
}

function startContentWatcher() {
  stopContentWatcher()
  let lastLength = document.body.textContent.length
  let debounceTimer = null
  let idleTimer = null
  const resetIdle = () => {
    clearTimeout(idleTimer)
    idleTimer = setTimeout(stopContentWatcher, 30000)
  }
  contentWatcher = new MutationObserver(() => {
    const newLength = document.body.textContent.length
    if (newLength - lastLength < 200) return
    lastLength = newLength
    resetIdle()
    clearTimeout(debounceTimer)
    debounceTimer = setTimeout(() => {
      if (!isInitialized) return
      removeHighlights()
      runIncrementalScan()
      if (abbrMap.size > 0) {
        if (!sidebarHost) injectSidebar()
        populateSidebar()
        highlightAbbreviations()
        chrome.runtime.sendMessage({ action: 'updateBadge', count: abbrMap.size })
      } else if (sidebarHost) {
        populateSidebar()
      }
    }, 1500)
  })
  contentWatcher.observe(document.body, { childList: true, subtree: true })
  resetIdle()
}

function isExcludedPage() {
  const host = window.location.hostname.toLowerCase()
  const path = window.location.pathname.toLowerCase()
  const excludedDomains = [
    'google.', 'bing.com', 'yahoo.com', 'duckduckgo.com', 'baidu.com',
    'yandex.', 'ask.com', 'ecosia.org', 'startpage.com', 'search.brave.com',
    'mail.google.com', 'outlook.live.com', 'outlook.office.com',
    'mail.yahoo.com', 'mail.aol.com', 'protonmail.com', 'proton.me',
    'zoho.com/mail', 'icloud.com', 'fastmail.com',
  ]
  if (excludedDomains.some(d => host.includes(d))) return true
  if (host.includes('outlook.com') && path.startsWith('/mail')) return true
  return false
}

function looksLikeAcademicPage() {
  if (isExcludedPage()) return false
  // Extension's own PDF viewer always qualifies
  if (typeof chrome !== 'undefined' && chrome.runtime &&
      window.location.href.startsWith(chrome.runtime.getURL(''))) return true
  const url = window.location.href.toLowerCase()
  const referrer = (window !== window.top && document.referrer)
    ? document.referrer.toLowerCase() : ''
  const domains = [
    'pubmed','ncbi','nejm','bmj','thelancet','nature.com','science.org',
    'cell.com','jamanetwork','wiley','springer','elsevier','tandfonline',
    'biorxiv','medrxiv','arxiv','plos','frontiersin','mdpi',
    'academic.oup','journals.lww','ahajournals','acpjournals',
    'cochranelibrary','embase','clinicaltrials'
  ]
  if (domains.some(d => url.includes(d) || referrer.includes(d))) return true
  if (document.querySelector('meta[name="citation_title"]')) return true
  if (document.querySelector('meta[name="dc.title"]'))       return true
  const title = document.title.toLowerCase()
  if (title.includes('doi:') || title.includes('abstract'))  return true
  return false
}

// --- SECTION J: SPA URL-CHANGE DETECTION ---

function handleUrlChange() {
  if (window.location.href !== currentUrl) {
    currentUrl = window.location.href
    setTimeout(() => { cleanup(); main() }, 1200)
  }
}

window.addEventListener('popstate',   handleUrlChange)
window.addEventListener('hashchange', handleUrlChange)
setInterval(handleUrlChange, 2000)

// --- SECTION K: CUSTOM ABBREVIATIONS (PERSISTENT) ---

function saveCustomAbbreviations() {
  const obj = {}
  for (const [abbr, entry] of customAbbrMap.entries()) obj[abbr] = entry
  chrome.storage.local.set({ abbrscan_custom: obj })
}

function addCustomAbbreviation(abbr, definition) {
  abbr       = abbr.trim()
  definition = definition.trim()
  if (!abbr || !definition) return false
  customAbbrMap.set(abbr, { definition, confidence: 4 })
  abbrMap.set(abbr, { definition, confidence: 4 })
  saveCustomAbbreviations()
  return true
}

// --- SECTION L: SELECTION BUBBLE ---

const BUBBLE_CSS = `
  * { box-sizing:border-box; margin:0; padding:0;
      font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif; }
  #abbrscan-bubble {
    background:#1e293b; color:#f1f5f9; border-radius:8px;
    box-shadow:0 4px 16px rgba(0,0,0,0.35); font-size:12px; padding:7px 11px;
  }
  #bubble-trigger { cursor:pointer; color:#93c5fd; white-space:nowrap; display:flex; align-items:center; gap:5px; }
  #bubble-trigger:hover { color:#bfdbfe; }
  #bubble-form { display:none; margin-top:8px; width:260px; }
  #bubble-row  { display:flex; gap:6px; }
  #bubble-abbr {
    width:90px; flex-shrink:0; padding:5px 8px;
    background:#334155; border:1px solid #475569; border-radius:4px;
    color:#f1f5f9; font-size:12px; font-weight:600; outline:none;
  }
  #bubble-def {
    flex:1; padding:5px 8px;
    background:#334155; border:1px solid #475569; border-radius:4px;
    color:#f1f5f9; font-size:12px; outline:none;
  }
  #bubble-abbr:focus, #bubble-def:focus { border-color:#93c5fd; }
  #bubble-actions { display:flex; gap:6px; justify-content:flex-end; margin-top:6px; }
  #bubble-cancel, #bubble-save {
    padding:4px 12px; border:none; border-radius:4px; font-size:11px;
    cursor:pointer; font-weight:500;
  }
  #bubble-cancel { background:#475569; color:#e2e8f0; }
  #bubble-save   { background:#1e40af; color:white; }
  #bubble-save:hover { background:#1d3a9e; }
  #bubble-error { color:#f87171; font-size:11px; margin-top:4px; display:none; }
`

const BUBBLE_HTML = `
  <div id="abbrscan-bubble">
    <div id="bubble-trigger">&#43; Add abbreviation</div>
    <div id="bubble-form">
      <div id="bubble-row">
        <input id="bubble-abbr" type="text" placeholder="ABBR" maxlength="10">
        <input id="bubble-def"  type="text" placeholder="Full definition\u2026">
      </div>
      <div id="bubble-actions">
        <button id="bubble-cancel">Cancel</button>
        <button id="bubble-save">Save</button>
      </div>
      <div id="bubble-error"></div>
    </div>
  </div>
`

function hideSelectionBubble() {
  if (selectionBubbleHost) { selectionBubbleHost.remove(); selectionBubbleHost = null }
}

function showSelectionBubble(selectedText, rect) {
  hideSelectionBubble()

  // Smart parse: "Full Term (ABBR)" or "(ABBR) Full Term"
  let autoAbbr = '', autoDef = ''
  const m1 = selectedText.match(/^(.{2,60})\s+\(([A-Za-z][A-Za-z0-9\-]{0,8})\)\s*$/)
  const m2 = selectedText.match(/^\(([A-Za-z][A-Za-z0-9\-]{0,8})\)\s+(.{2,60})\s*$/)
  if (m1)      { autoDef = m1[1].trim(); autoAbbr = m1[2] }
  else if (m2) { autoAbbr = m2[1]; autoDef = m2[2].trim() }
  else         { autoDef = selectedText.trim().slice(0, 100) }

  const { host, shadow } = createShadowHost(ABBRSCAN_BUBBLE_ID, BUBBLE_CSS, BUBBLE_HTML)
  selectionBubbleHost = host

  const trigger   = shadow.getElementById('bubble-trigger')
  const form      = shadow.getElementById('bubble-form')
  const abbrInput = shadow.getElementById('bubble-abbr')
  const defInput  = shadow.getElementById('bubble-def')
  const cancelBtn = shadow.getElementById('bubble-cancel')
  const saveBtn   = shadow.getElementById('bubble-save')
  const errorEl   = shadow.getElementById('bubble-error')

  function positionBubble() {
    const bw = host.offsetWidth  || 160
    const bh = host.offsetHeight || 36
    let x = rect.left + rect.width / 2 - bw / 2
    let y = rect.top - bh - 10
    if (y < 8) y = rect.bottom + 10
    x = Math.max(8, Math.min(x, window.innerWidth  - bw - 8))
    y = Math.max(8, Math.min(y, window.innerHeight - bh - 8))
    host.style.left = x + 'px'
    host.style.top  = y + 'px'
  }
  requestAnimationFrame(positionBubble)

  // If smart-detected, open form immediately
  if (autoAbbr) {
    form.style.display = 'block'
    abbrInput.value    = autoAbbr
    defInput.value     = autoDef
    requestAnimationFrame(() => { positionBubble(); abbrInput.focus(); abbrInput.select() })
  }

  trigger.addEventListener('click', () => {
    form.style.display = 'block'
    abbrInput.value    = autoAbbr
    defInput.value     = autoDef
    requestAnimationFrame(() => { positionBubble(); abbrInput.focus() })
  })

  cancelBtn.addEventListener('click', hideSelectionBubble)

  function trySave() {
    const abbr = abbrInput.value.trim()
    const def  = defInput.value.trim()
    errorEl.style.display = 'none'
    if (!abbr) { errorEl.textContent = 'Abbreviation is required'; errorEl.style.display = 'block'; return }
    if (!def)  { errorEl.textContent = 'Definition is required';   errorEl.style.display = 'block'; return }
    if (!/^[A-Za-z][A-Za-z0-9\-]{0,8}$/.test(abbr)) {
      errorEl.textContent = 'Must start with a letter, max 9 chars'
      errorEl.style.display = 'block'; return
    }
    addCustomAbbreviation(abbr, def)
    removeHighlights(); runScan(); highlightAbbreviations(); populateSidebar()
    chrome.runtime.sendMessage({ action: 'updateBadge', count: abbrMap.size })
    hideSelectionBubble()
  }

  saveBtn.addEventListener('click', trySave)
  ;[abbrInput, defInput].forEach(inp => {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter')  trySave()
      if (e.key === 'Escape') hideSelectionBubble()
    })
  })
}

// Show bubble on text selection; hide on outside click
document.addEventListener('mouseup', (e) => {
  if (!isInitialized) return
  const path = e.composedPath ? e.composedPath() : []
  if (path.some(el => el.id === ABBRSCAN_BUBBLE_ID)) return
  setTimeout(() => {
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) {
      if (!path.some(el => el.id === ABBRSCAN_BUBBLE_ID)) hideSelectionBubble()
      return
    }
    const text = sel.toString().trim()
    if (text.length < 2 || text.length > 200) return
    const range = sel.getRangeAt(0)
    showSelectionBubble(text, range.getBoundingClientRect())
  }, 50)
})

document.addEventListener('scroll', hideSelectionBubble, { passive: true, capture: true })
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') hideSelectionBubble() })

// --- SECTION M: ALL MESSAGE HANDLERS ---

// Relay rescan into child iframes (e.g. PDF viewers embedded in an <iframe>)
window.addEventListener('message', (e) => {
  if (e.data !== 'abbrscan_rescan') return
  if (isInitialized) cleanup()
  isInitialized = true
  injectTooltip()
  runFullScan()
})

chrome.runtime.onMessage.addListener((message) => {
  if (message.action === 'rescan') {
    chrome.storage.local.set({ [ENABLED_KEY]: true })
    if (isInitialized) cleanup()
    isInitialized = true
    injectTooltip()
    runFullScan()
    document.querySelectorAll('iframe, frame').forEach(f => {
      try { f.contentWindow.postMessage('abbrscan_rescan', '*') } catch (e) { /* cross-origin frame, expected */ }
    })
  }
  if (message.action === 'showSidebar') {
    if (!sidebarHost && abbrMap.size > 0) { injectSidebar(); populateSidebar() }
  }
  if (message.action === 'disable') {
    chrome.storage.local.set({ [ENABLED_KEY]: false })
    cleanup()
  }
})

// --- SECTION N: MAIN ---

function runFullScan() {
  runScan()
  injectSidebar()
  populateSidebar()
  highlightAbbreviations()
  chrome.runtime.sendMessage({ action: 'updateBadge', count: abbrMap.size })
  if (abbrMap.size === 0 || isLazyContentPage()) startContentWatcher()
}

function main() {
  if (isInitialized) cleanup()
  isInitialized = true
  if (!looksLikeAcademicPage()) return
  chrome.storage.local.get(['abbrscan_custom', ENABLED_KEY], (data) => {
    const enabled = data[ENABLED_KEY] !== false
    if (!enabled) return
    // Restore persisted custom abbreviations
    const stored = data.abbrscan_custom || {}
    customAbbrMap.clear()
    for (const [abbr, entry] of Object.entries(stored)) customAbbrMap.set(abbr, entry)
    injectTooltip()
    runFullScan()
  })
}

main()
