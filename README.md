# AbbrScan — Medical Abbreviation Decoder

Automatically detects and decodes abbreviations in research papers.
Silent on all other pages.

## Activation

- **Research pages** — runs automatically on load
- **All other pages** — does nothing
- **Manual** — click extension icon → "Scan This Page" works on any page
- **Disable per site** — toggle in popup persists across reloads for that hostname

## Installation

### Step 1 — Generate icons (one time only)

1. Open `icons/generate_icons.html` in Chrome
2. Click all three download buttons
3. Move downloaded files into the `icons/` folder

### Step 2 — Load in Chrome

1. `chrome://extensions` → enable **Developer mode** (top right)
2. **Load unpacked** → select the `abbrscan/` folder
3. AbbrScan icon appears in toolbar

## Test pages

- https://pubmed.ncbi.nlm.nih.gov/36265170/
- https://pmc.ncbi.nlm.nih.gov/articles/PMC9069743/
- https://www.nejm.org/doi/full/10.1056/NEJMoa2110345

## After code changes

`chrome://extensions` → click **↺** on AbbrScan → `Cmd+Shift+R` on page

## Detection

| Pattern | Example | Confidence |
|---|---|---|
| Abbreviation table | Dedicated section at paper end | 3 |
| Full Term (ABBR) | "randomised controlled trial (RCT)" | 2 |
| (ABBR) Full Term | "(CI) confidence interval" | 1 |

Mixed-case supported: mRNA, IgG, mAbs, siRNA, pH, kDa

## Troubleshooting

| Problem | Fix |
|---|---|
| Sidebar doesn't appear | F12 → Console → check errors from content.js |
| Badge always 0 | Click ↺ on extension, hard-reload page |
| Sidebar off-screen | DevTools console: `chrome.storage.local.remove('abbrscanPos')` |
| Site permanently disabled | DevTools console: `chrome.storage.local.remove('abbrscan_enabled_pubmed.ncbi.nlm.nih.gov')` |
| No abbreviations found | Try popup "Scan This Page" |
