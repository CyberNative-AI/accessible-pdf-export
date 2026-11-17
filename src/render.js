// Renders a note with Obsidian's own renderer, prepares the page for print, and prints it with Chromium's
// tagged-PDF output switched on. Returns the raw tagged PDF and what the fix-up needs to know about links.
// Everything it reads or writes goes through the vault API, never the Node file-system module.
const { MarkdownRenderer, Component, TFile, arrayBufferToBase64, normalizePath } = require('obsidian');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

// Waits until images have loaded and the rendered DOM stops changing (embeds, math and diagrams render late).
async function settle(el, maxMs = 15000) {
  const end = Date.now() + maxMs; let changed = Date.now();
  const mo = new MutationObserver(() => { changed = Date.now(); });
  mo.observe(el, { subtree: true, childList: true, attributes: true, characterData: true });
  try {
    while (Date.now() < end) {
      const imgs = [...el.querySelectorAll('img')];
      if (imgs.every((i) => i.complete) && Date.now() - changed > 600) return;
      await sleep(100);
    }
  } finally { mo.disconnect(); }
}

// The vault path of an absolute file path, or null when the file is outside the vault.
function vaultRelative(app, abs) {
  const base = app.vault.adapter.getBasePath ? app.vault.adapter.getBasePath() : null;
  if (!base || !abs) return null;
  const slash = (x) => x.replace(/\\/g, '/').replace(/\/+$/, '');
  const b = slash(base), a = slash(abs);
  const win = /^[a-zA-Z]:\//.test(b);
  const inside = win ? a.toLowerCase().startsWith(b.toLowerCase() + '/') : a.startsWith(b + '/');
  return inside ? normalizePath(a.slice(b.length + 1)) : null;
}

// Images from the vault are embedded as data so the print window needs nothing from the app.
async function embedImages(app, el) {
  for (const img of el.querySelectorAll('img')) {
    const src = img.getAttribute('src') || '';
    const m = src.match(/^app:\/\/[^/]+\/(.*?)(\?|$)/);
    if (!m) continue;
    try {
      let p = decodeURIComponent(m[1]);
      if (!/^[a-zA-Z]:[\\/]/.test(p) && !p.startsWith('/')) p = '/' + p; // app://<id>/home/... on macOS and Linux
      const rel = vaultRelative(app, p);
      const f = rel && app.vault.getAbstractFileByPath(rel);
      if (!(f instanceof TFile)) throw new Error('not a file in this vault');
      const mime = { svg: 'image/svg+xml', jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', bmp: 'image/bmp' }[f.extension.toLowerCase()];
      if (mime) img.setAttribute('src', `data:${mime};base64,${arrayBufferToBase64(await app.vault.readBinary(f))}`);
    } catch (e) { console.warn('Accessible PDF Export: image not embedded', src, e); }
  }
}

function prepare(el) {
  // Screen controls have no meaning on paper.
  el.querySelectorAll('.copy-code-button, .collapse-indicator, .heading-collapse-indicator, .edit-block-button, ' +
    '.markdown-embed-link, .callout-fold, .frontmatter, .frontmatter-container, .metadata-container, .mod-header, ' +
    '.mermaid-guard-header, button')
    .forEach((x) => x.remove());
  // Links into the vault and tags point nowhere outside Obsidian: keep their text, drop the link.
  for (const a of el.querySelectorAll('a')) {
    const href = a.getAttribute('href') || '';
    const external = /^(https?:|mailto:)/i.test(href) && !a.classList.contains('internal-link');
    const fragment = href.startsWith('#') && !a.classList.contains('tag') && !a.classList.contains('internal-link');
    if (external || fragment) continue;
    const s = document.createElement('span'); s.className = a.className; s.append(...a.childNodes); a.replaceWith(s);
  }
  // Every table row gets the same number of cells (PDF/UA requires it; Markdown allows short rows).
  for (const table of el.querySelectorAll('table')) {
    const rows = [...table.rows];
    const width = (r) => [...r.cells].reduce((n, c) => n + (c.colSpan || 1), 0);
    const max = Math.max(0, ...rows.map(width));
    for (const r of rows) for (let n = width(r); n < max; n++) r.appendChild(document.createElement(r.parentElement.tagName === 'THEAD' ? 'th' : 'td'));
  }
  // Header cells name their direction for screen readers.
  for (const th of el.querySelectorAll('thead th')) if (!th.hasAttribute('scope')) th.setAttribute('scope', 'col');
  // Link texts, for the descriptions the PDF needs on each link.
  const links = new Map();
  for (const a of el.querySelectorAll('a[href]')) {
    const href = a.getAttribute('href'); const text = (a.textContent || '').trim().replace(/\s+/g, ' ');
    const key = href.startsWith('#') ? href : a.href;
    if (text && !links.has(key)) links.set(key, text);
  }
  return links;
}

function pageCss() {
  const parts = [];
  for (const s of document.styleSheets) { try { for (const r of s.cssRules) parts.push(r.cssText); } catch (e) { /* cross-origin sheet */ } }
  return parts.join('\n');
}

async function renderNote(app, file, opt) {
  const md = await app.vault.cachedRead(file);
  const host = document.body.createDiv();
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:800px';
  const el = host.createDiv({ cls: 'markdown-preview-view markdown-rendered' });
  const comp = new Component(); comp.load();
  let html, links;
  try {
    await MarkdownRenderer.render(app, md, el, file.path, comp);
    await settle(el);
    await embedImages(app, el);
    links = prepare(el);
    const bodyCls = document.body.className.replace(/\btheme-dark\b/, 'theme-light');
    const title = opt.includeTitle ? `<h1>${esc(opt.title)}</h1>` : '';
    html = `<!DOCTYPE html><html lang="${esc(opt.lang)}"><head><meta charset="utf-8"><title>${esc(opt.title)}</title>` +
      `<style>${pageCss()}\n@media print { body { overflow: visible !important; height: auto !important; } }</style></head>` +
      `<body class="${esc(bodyCls)}" style="background:#fff"><div class="print"><div class="markdown-preview-view markdown-rendered">` +
      `${title}${el.innerHTML}</div></div></body></html>`;
  } finally { comp.unload(); host.remove(); }
  return { html, links };
}

// The page is staged as a hidden file in the plugin's own folder (through the vault adapter), loaded, and removed.
async function printTagged(app, pluginDir, html, pageSize) {
  const { remote } = require('electron');
  const adapter = app.vault.adapter;
  const rel = normalizePath(`${pluginDir}/.export-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.html`);
  const drop = async () => { try { if (await adapter.exists(rel)) await adapter.remove(rel); } catch (e) { /* already gone */ } };
  await adapter.write(rel, html);
  const w = new remote.BrowserWindow({ show: false, webPreferences: { javascript: false } });
  try {
    await w.loadFile(adapter.getFullPath(rel));
    await drop();
    const buf = await w.webContents.printToPDF({ generateTaggedPDF: true, generateDocumentOutline: true, pageSize, printBackground: true });
    return Buffer.from(buf);
  } finally { w.destroy(); await drop(); }
}

module.exports = { renderNote, printTagged, vaultRelative };
