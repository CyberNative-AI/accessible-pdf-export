// node test/save-plan.test.cjs [RAW_CHROMIUM_PDF]
// Checks the "save next to the note" rule in the built main.js with a fake vault: a PDF the plugin made is replaced,
// any other file with that name is never touched. With a raw Chromium PDF, also checks that fixup() leaves the
// CreatorTool mark readable in the saved bytes (the rule depends on it).
const Module = require('module');
const assert = require('assert');
const path = require('path');
const fs = require('fs');

class TFile { constructor(p, bytes) { this.path = p; this.bytes = bytes; } }
class Notice { constructor() {} hide() {} }
const orig = Module._load;
Module._load = function (req, ...a) {
  if (req === 'obsidian') return { Plugin: class { constructor(app) { this.app = app; } }, Notice, PluginSettingTab: class {}, Setting: class {}, TFile, normalizePath: (p) => p };
  return orig.call(this, req, ...a);
};
const Plugin = require(path.join(__dirname, '..', 'main.js'));
const { CREATOR_MARK } = (() => { const s = fs.readFileSync(path.join(__dirname, '..', 'src', 'fixup.js'), 'utf8'); return { CREATOR_MARK: s.match(/const CREATOR_MARK = '([^']+)'/)[1] }; })();

function vault(files) {
  const m = new Map(Object.entries(files).map(([p, b]) => [p, new TFile(p, Buffer.from(b))]));
  const log = [];
  return { m, log,
    getAbstractFileByPath: (p) => m.get(p) || null,
    readBinary: async (f) => f.bytes.buffer.slice(f.bytes.byteOffset, f.bytes.byteOffset + f.bytes.byteLength),
    modifyBinary: async (f, d) => { log.push(['modify', f.path]); f.bytes = Buffer.from(d); },
    createBinary: async (p, d) => { log.push(['create', p]); m.set(p, new TFile(p, Buffer.from(d))); },
  };
}
const OURS = `%PDF-1.7 <xmp:CreatorTool>${CREATOR_MARK}</xmp:CreatorTool>`;
const FOREIGN = '%PDF-1.7 a scanned contract the user filed next to the note';

async function run(files) {
  const v = vault(files);
  const p = new Plugin({ vault: v });
  p.settings = { saveTo: 'next' };
  p.buildPdf = async () => ({ pdf: Buffer.from(OURS + ' new') });
  await p.exportFile({ basename: 'Note', parent: { path: 'dir' } });
  return v;
}

(async () => {
  let v = await run({});
  assert.deepStrictEqual(v.log, [['create', 'dir/Note.pdf']]);

  v = await run({ 'dir/Note.pdf': OURS });
  assert.deepStrictEqual(v.log, [['modify', 'dir/Note.pdf']]);

  v = await run({ 'dir/Note.pdf': FOREIGN });
  assert.deepStrictEqual(v.log, [['create', 'dir/Note (accessible).pdf']]);
  assert.strictEqual(v.m.get('dir/Note.pdf').bytes.toString(), FOREIGN);

  v = await run({ 'dir/Note.pdf': FOREIGN, 'dir/Note (accessible).pdf': FOREIGN });
  assert.deepStrictEqual(v.log, [['create', 'dir/Note (accessible 2).pdf']]);

  v = await run({ 'dir/Note.pdf': FOREIGN, 'dir/Note (accessible).pdf': OURS });
  assert.deepStrictEqual(v.log, [['modify', 'dir/Note (accessible).pdf']]);
  console.log('save-plan: 5/5 OK');

  const raw = process.argv[2];
  if (raw) {
    const { fixup } = (() => { Module._load = orig; return require(path.join(__dirname, '..', 'src', 'fixup.js')); })();
    const out = fixup(fs.readFileSync(raw), { title: 'T', lang: 'en', links: new Map() });
    const bytes = Buffer.from(out.pdf || out);
    assert.ok(bytes.includes(Buffer.from(CREATOR_MARK, 'latin1')), 'CreatorTool mark not readable in fixup output');
    console.log('fixup mark: OK on', path.basename(raw));
  }
})().catch((e) => { console.error(e); process.exit(1); });
