const { Plugin, Notice, PluginSettingTab, Setting, TFile, normalizePath } = require('obsidian');
const { renderNote, printTagged } = require('./render');
const { fixup, CREATOR_MARK } = require('./fixup');

const DEFAULTS = { pageSize: 'A4', lang: 'en', includeTitle: true, saveTo: 'next' };
const LANG_RE = /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/;

// A PDF next to the note is replaced only when this plugin made it (its CreatorTool mark is in the uncompressed XMP).
// Any other file with that name is left alone and the export gets "<note> (accessible).pdf", then numbered names.
async function savePlan(vault, file) {
  const dir = file.parent && file.parent.path !== '/' ? file.parent.path + '/' : '';
  for (let n = 0; n < 100; n++) {
    const suffix = n === 0 ? '' : n === 1 ? ' (accessible)' : ` (accessible ${n})`;
    const p = normalizePath(dir + file.basename + suffix + '.pdf');
    const existing = vault.getAbstractFileByPath(p);
    if (!existing) return { path: p, existing: null };
    if (existing instanceof TFile && await madeByUs(vault, existing)) return { path: p, existing };
  }
  throw new Error('no free file name next to the note');
}
async function madeByUs(vault, f) {
  try { return Buffer.from(await vault.readBinary(f)).includes(Buffer.from(CREATOR_MARK, 'latin1')); } catch (e) { return false; }
}

class AccessiblePdfPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULTS, await this.loadData());
    this.addCommand({
      id: 'export-current-note',
      name: 'Export current note to accessible PDF',
      checkCallback: (checking) => {
        const f = this.app.workspace.getActiveFile();
        if (!(f instanceof TFile) || f.extension !== 'md') return false;
        if (!checking) this.exportFile(f);
        return true;
      },
    });
    this.registerEvent(this.app.workspace.on('file-menu', (menu, file) => {
      if (!(file instanceof TFile) || file.extension !== 'md') return;
      menu.addItem((i) => i.setTitle('Export to accessible PDF').setIcon('file-output').onClick(() => this.exportFile(file)));
    }));
    this.addSettingTab(new AccessiblePdfSettings(this.app, this));
  }

  languageFor(file) {
    const fm = (this.app.metadataCache.getFileCache(file) || {}).frontmatter || {};
    for (const v of [fm.lang, fm.language, this.settings.lang]) if (typeof v === 'string' && LANG_RE.test(v.trim())) return v.trim();
    return 'en';
  }

  // The whole export: render, print tagged, fix up. Returns the PDF bytes and what was fixed.
  async buildPdf(file) {
    const title = file.basename; const lang = this.languageFor(file);
    const { html, links } = await renderNote(this.app, file, { title, lang, includeTitle: this.settings.includeTitle });
    const raw = await printTagged(html, this.settings.pageSize);
    return fixup(raw, { title, lang, links });
  }

  async exportFile(file) {
    const notice = new Notice(`Exporting ${file.basename} to accessible PDF…`, 0);
    try {
      const { pdf } = await this.buildPdf(file);
      let where;
      if (this.settings.saveTo === 'ask') {
        const { remote } = require('electron');
        const base = this.app.vault.adapter.getBasePath ? this.app.vault.adapter.getBasePath() : '';
        const r = await remote.dialog.showSaveDialog({ defaultPath: require('path').join(base, (file.parent ? file.parent.path : ''), file.basename + '.pdf'), filters: [{ name: 'PDF', extensions: ['pdf'] }] });
        if (r.canceled || !r.filePath) { notice.hide(); return; }
        require('fs').writeFileSync(r.filePath, pdf); where = r.filePath;
      } else {
        const { path: p, existing } = await savePlan(this.app.vault, file);
        const data = pdf.buffer.slice(pdf.byteOffset, pdf.byteOffset + pdf.byteLength);
        if (existing) await this.app.vault.modifyBinary(existing, data); else await this.app.vault.createBinary(p, data);
        where = p;
      }
      notice.hide(); new Notice(`Saved ${where}`);
    } catch (e) {
      notice.hide(); console.error('Accessible PDF export failed', e);
      new Notice(`Accessible PDF export failed: ${e && e.message ? e.message : e}`, 10000);
    }
  }

  async saveSettings() { await this.saveData(this.settings); }
}

class AccessiblePdfSettings extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this; containerEl.empty();
    const s = this.plugin.settings; const save = () => this.plugin.saveSettings();
    new Setting(containerEl).setName('Page size').addDropdown((d) => d.addOptions({ A4: 'A4', Letter: 'Letter', Legal: 'Legal' })
      .setValue(s.pageSize).onChange((v) => { s.pageSize = v; save(); }));
    new Setting(containerEl).setName('Document language')
      .setDesc('Language code screen readers use, such as en, de or pt-BR. A lang or language property in the note takes precedence.')
      .addText((t) => t.setPlaceholder('en').setValue(s.lang).onChange((v) => { if (!v || LANG_RE.test(v.trim())) { s.lang = v.trim() || 'en'; save(); } }));
    new Setting(containerEl).setName('Note name as title').setDesc('Print the note name as the first heading.')
      .addToggle((t) => t.setValue(s.includeTitle).onChange((v) => { s.includeTitle = v; save(); }));
    new Setting(containerEl).setName('Where to save').addDropdown((d) => d.addOptions({ next: 'Next to the note', ask: 'Ask each time' })
      .setValue(s.saveTo).onChange((v) => { s.saveTo = v; save(); }));
  }
}

module.exports = AccessiblePdfPlugin;
