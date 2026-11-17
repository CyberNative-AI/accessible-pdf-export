// Turns a tagged PDF printed by Chromium into PDF/UA-1: metadata, role map, list bodies, heading order,
// link descriptions and artifacts. Input must come from Chromium's printToPDF with generateTaggedPDF.
const { PdfDoc, Ref, Dict, Stream, Name, name, isName, textString, decodeText } = require('./pdf');
const { wrapArtifacts, hasMarkedContent, tokenize, markedBoxes, PATH_BUILD, PATH_PAINT } = require('./content');

const STANDARD = new Set(('Document Part Art Sect Div BlockQuote Caption TOC TOCI Index NonStruct Private P H H1 H2 H3 H4 H5 H6 ' +
  'L LI Lbl LBody Table TR TH TD THead TBody TFoot Span Quote Note Reference BibEntry Code Link Annot Ruby RB RT RP ' +
  'Warichu WT WP Figure Formula Form').split(' '));
const INLINE = new Set(['Strong', 'Em', 'Mark', 'Sub', 'Sup', 'Small', 'B', 'I', 'U', 'S', 'Del', 'Ins', 'Kbd', 'Samp', 'Var', 'Abbr', 'Cite', 'Time', 'Label']);
const CREATOR_MARK = 'Obsidian with Accessible PDF Export';

const xmlEsc = (s) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

function xmp(title, producer, creator) {
  return '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>\n' +
    '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n<rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">\n' +
    '<rdf:Description rdf:about="" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:pdf="http://ns.adobe.com/pdf/1.3/" ' +
    'xmlns:xmp="http://ns.adobe.com/xap/1.0/" xmlns:pdfuaid="http://www.aiim.org/pdfua/ns/id/">\n' +
    '<dc:format>application/pdf</dc:format>\n' +
    `<dc:title><rdf:Alt><rdf:li xml:lang="x-default">${xmlEsc(title)}</rdf:li></rdf:Alt></dc:title>\n` +
    `<pdf:Producer>${xmlEsc(producer)}</pdf:Producer>\n<xmp:CreatorTool>${xmlEsc(creator)}</xmp:CreatorTool>\n` +
    '<pdfuaid:part>1</pdfuaid:part>\n</rdf:Description>\n</rdf:RDF>\n</x:xmpmeta>\n' + ' '.repeat(512) + '\n<?xpacket end="w"?>';
}

const kidsOf = (doc, el) => { const k = el.get('K'); return k == null ? [] : Array.isArray(k) ? k : [k]; };

// opts: { title, lang, links: Map(href -> text) }
function fixup(input, opts = {}) {
  const doc = new PdfDoc(Buffer.from(input));
  const cat = doc.catalog; const catRef = doc.trailer.get('Root');
  const report = { artifacts: 0, roleMap: [], lbody: 0, headings: 0, links: 0 };
  const info = doc.resolve(doc.trailer.get('Info'));
  const title = opts.title || (info && decodeText(info.get('Title'))) || 'Untitled';
  const producer = (info && decodeText(info.get('Producer'))) || '';
  const creator = CREATOR_MARK;

  // 1. Catalog: metadata, title display, language, marked.
  const meta = new Stream(new Dict().set('Type', name('Metadata')).set('Subtype', name('XML')), Buffer.alloc(0));
  doc.setStreamData(meta, Buffer.from(xmp(title, producer, creator), 'utf8'), false);
  cat.set('Metadata', doc.add(meta));
  const vp = doc.resolve(cat.get('ViewerPreferences')) || new Dict();
  vp.set('DisplayDocTitle', true); cat.set('ViewerPreferences', vp);
  if (opts.lang) cat.set('Lang', textString(opts.lang));
  else if (!cat.get('Lang')) cat.set('Lang', textString('en'));
  cat.set('MarkInfo', new Dict().set('Marked', true));
  if (info) { info.set('Title', textString(title)); info.set('Creator', textString(creator)); doc.touch(doc.trailer.get('Info')); }
  doc.touch(catRef);

  const str = doc.resolve(cat.get('StructTreeRoot'));
  if (!str) throw new Error('the PDF has no structure tree (was it printed with tagging on?)');
  const strRef = cat.get('StructTreeRoot');

  // Pages: StructParents key per page object number.
  const pages = []; const walkPages = (ref) => { const n = doc.resolve(ref); if (isName(n.get('Type'), 'Pages')) for (const k of n.get('Kids')) walkPages(k); else pages.push({ ref, d: n }); };
  walkPages(cat.get('Pages'));
  const spOfPage = new Map(pages.map((p) => [p.ref.n, p.d.get('StructParents')]));

  // Parent tree: key -> array of refs (or ref for OBJR).
  const ptRef = str.get('ParentTree'); const pt = doc.resolve(ptRef); const parentTree = new Map();
  const loadNT = (node) => { node = doc.resolve(node); const nums = node.get('Nums'); if (nums) for (let i = 0; i < nums.length; i += 2) { const v = doc.resolve(nums[i + 1]); parentTree.set(nums[i], Array.isArray(v) ? [...v] : nums[i + 1]); } const kids = node.get('Kids'); if (kids) for (const k of kids) loadNT(k); };
  loadNT(pt);

  // Walk the structure tree in document order.
  const elems = []; // { ref, d, parent, pg }
  const walk = (ref, parent, pg) => {
    const d = doc.resolve(ref); if (!(d instanceof Dict) || !d.get('S')) return;
    const mypg = d.get('Pg') || pg; elems.push({ ref, d, parent, pg: mypg });
    for (const k of kidsOf(doc, d)) if (k instanceof Ref) { const kd = doc.resolve(k); if (kd instanceof Dict && kd.get('S')) walk(k, ref, mypg); }
  };
  for (const k of kidsOf(doc, str)) walk(k, strRef, null);

  // 2. Role map for non-standard types.
  const rm = doc.resolve(str.get('RoleMap')) || new Dict();
  for (const e of elems) { const s = e.d.get('S').v; if (!STANDARD.has(s) && !rm.has(s)) { rm.set(s, name(INLINE.has(s) ? 'Span' : 'Div')); report.roleMap.push(s); } }
  if (rm.m.size) { str.set('RoleMap', rm); doc.touch(strRef); }
  const role = (d) => { const s = d.get('S').v; const m = rm.get(s); return m ? m.v : s; };

  // 3. LI children must be Lbl or LBody.
  const setParent = (kid, newRef, pg) => {
    if (kid instanceof Ref) {
      const kd = doc.resolve(kid);
      if (kd instanceof Dict && kd.get('S')) { kd.set('P', newRef); doc.touch(kid); return; }
      if (kd instanceof Dict && isName(kd.get('Type'), 'OBJR')) { const a = doc.resolve(kd.get('Obj')); parentTree.set(a.get('StructParent'), newRef); return; }
      if (kd instanceof Dict && isName(kd.get('Type'), 'MCR')) { kid = kd; } else return;
    }
    if (typeof kid === 'number') { const arr = parentTree.get(spOfPage.get(pg && pg.n)); if (Array.isArray(arr)) arr[kid] = newRef; return; }
    if (kid instanceof Dict && isName(kid.get('Type'), 'OBJR')) { const a = doc.resolve(kid.get('Obj')); parentTree.set(a.get('StructParent'), newRef); return; }
    if (kid instanceof Dict && isName(kid.get('Type'), 'MCR')) {
      const stm = kid.get('Stm'); const key = stm ? doc.resolve(stm).dict.get('StructParents') : spOfPage.get((kid.get('Pg') || pg || {}).n);
      const arr = parentTree.get(key); if (Array.isArray(arr)) arr[kid.get('MCID')] = newRef;
    }
  };
  for (const e of elems) {
    if (role(e.d) !== 'LI') continue;
    const kids = kidsOf(doc, e.d);
    const isLblBody = (k) => { const kd = k instanceof Ref ? doc.resolve(k) : null; return kd instanceof Dict && kd.get('S') && ['Lbl', 'LBody'].includes(role(kd)); };
    if (kids.every(isLblBody)) continue;
    const keep = [], move = [];
    for (const k of kids) (isLblBody(k) && role(doc.resolve(k)) === 'Lbl' && move.length === 0 ? keep : move).push(k);
    const body = new Dict().set('Type', name('StructElem')).set('S', name('LBody')).set('P', e.ref).set('K', move);
    if (e.pg) body.set('Pg', e.pg);
    const bodyRef = doc.add(body);
    for (const k of move) setParent(k, bodyRef, e.pg);
    e.d.set('K', [...keep, bodyRef]); doc.touch(e.ref); report.lbody++;
  }

  // 3b. Every table row has the same number of cells. Chromium leaves empty cells out of the tree, so a Markdown row
  // with a blank cell comes out short; the missing cells are added back as empty TD (TH in a header row).
  const spanOf = (d) => { let n = 1; for (const a of [].concat(doc.resolve(d.get('A')) || [])) { const ad = doc.resolve(a); if (ad instanceof Dict && typeof ad.get('ColSpan') === 'number') n = ad.get('ColSpan'); } return n; };
  report.cells = 0;
  for (const e of elems) {
    if (role(e.d) !== 'Table') continue;
    const rows = [];
    const collect = (d) => { for (const k of kidsOf(doc, d)) { const kd = k instanceof Ref ? doc.resolve(k) : null; if (!(kd instanceof Dict) || !kd.get('S')) continue;
      const r = role(kd); if (r === 'TR') rows.push({ ref: k, d: kd }); else if (['THead', 'TBody', 'TFoot'].includes(r)) collect(kd); } };
    collect(e.d);
    const cellsOf = (d) => kidsOf(doc, d).filter((k) => { const kd = k instanceof Ref ? doc.resolve(k) : null; return kd instanceof Dict && kd.get('S') && ['TD', 'TH'].includes(role(kd)); });
    const width = (d) => cellsOf(d).reduce((n, k) => n + spanOf(doc.resolve(k)), 0);
    const max = Math.max(0, ...rows.map((r) => width(r.d)));
    for (const r of rows) {
      const w = width(r.d); if (w >= max) continue;
      const header = cellsOf(r.d).every((k) => role(doc.resolve(k)) === 'TH');
      const kids = kidsOf(doc, r.d).slice();
      for (let i = w; i < max; i++) { kids.push(doc.add(new Dict().set('Type', name('StructElem')).set('S', name(header ? 'TH' : 'TD')).set('P', r.ref))); report.cells++; }
      r.d.set('K', kids); doc.touch(r.ref);
    }
  }

  // 3c. Table grid lines. Chromium tags cell borders as marked content directly under Table (or a row group/row),
  // but only TR/THead/TBody/TFoot/Caption may sit there (and TH/TD in a TR). Content that only paints paths is
  // decoration: it becomes an Artifact and leaves the tree. Anything with text, images or forms stays as it is.
  report.grid = 0;
  const PAINT_ONLY = new Set([...PATH_BUILD, ...PATH_PAINT, 'W', 'W*', 'n', 'q', 'Q', 'cm', 'gs', 'w', 'J', 'j', 'M', 'd', 'ri', 'i',
    'CS', 'cs', 'SC', 'SCN', 'sc', 'scn', 'G', 'g', 'RG', 'rg', 'K', 'k']);
  const gridEdits = new Map(); // stream ref number -> { ref, stream, cuts: [[start, end]] }
  const findGrid = (stream, tag, mcid) => { // [start, end) of the BDC operator, or null if not paint-only
    const s = doc.streamData(stream).toString('latin1'); const ops = tokenize(s);
    for (let i = 0; i < ops.length; i++) {
      const o = ops[i];
      if (o.op !== 'BDC' || o.tag !== tag || !new RegExp(`/MCID\\s+${mcid}\\b`).test(s.slice(o.start, o.end))) continue;
      let depth = 1;
      for (let j = i + 1; j < ops.length; j++) {
        const p = ops[j];
        if (p.op === 'EMC' && --depth === 0) return [o.start, o.end];
        if (p.op === 'BDC' || p.op === 'BMC') { depth++; continue; }
        if (!PAINT_ONLY.has(p.op)) return null;
      }
      return null;
    }
    return null;
  };
  for (const e of elems) {
    if (!['Table', 'THead', 'TBody', 'TFoot', 'TR'].includes(role(e.d))) continue;
    const keep = []; let changed = false;
    for (const k of kidsOf(doc, e.d)) {
      const kd = k instanceof Ref ? doc.resolve(k) : k;
      let mcid = null, stmRef = null, pg = e.pg;
      if (typeof kd === 'number') mcid = kd;
      else if (kd instanceof Dict && isName(kd.get('Type'), 'MCR')) { mcid = kd.get('MCID'); stmRef = kd.get('Stm') || null; pg = kd.get('Pg') || e.pg; }
      if (mcid == null) { keep.push(k); continue; }
      let candidates = [];
      if (stmRef) candidates = [stmRef];
      else if (pg) { const c = doc.resolve(pg).get('Contents'); candidates = (Array.isArray(c) ? c : [c]).filter((r) => r instanceof Ref); }
      let hit = null;
      for (const r of candidates) { const cut = findGrid(doc.resolve(r), e.d.get('S').v, mcid); if (cut) { hit = { r, cut }; break; } }
      if (!hit) { keep.push(k); continue; }
      const ed = gridEdits.get(hit.r.n) || { ref: hit.r, stream: doc.resolve(hit.r), cuts: [] };
      ed.cuts.push(hit.cut); gridEdits.set(hit.r.n, ed);
      const key = stmRef ? ed.stream.dict.get('StructParents') : spOfPage.get(pg && pg.n);
      const arr = parentTree.get(key); if (Array.isArray(arr)) arr[mcid] = null;
      changed = true; report.grid++;
    }
    if (changed) { e.d.set('K', keep); doc.touch(e.ref); }
  }
  for (const ed of gridEdits.values()) {
    let s = doc.streamData(ed.stream).toString('latin1');
    for (const [a, b] of ed.cuts.sort((x, y) => y[0] - x[0])) s = s.slice(0, a) + '/Artifact BMC' + s.slice(b);
    doc.setStreamData(ed.stream, Buffer.from(s, 'latin1')); doc.touch(ed.ref);
  }

  // 3d. Figures (and formulas) get a page-space BBox from what their own marked content paints. PAC fails a Figure
  // without one. A figure whose content spans pages, or whose box cannot be measured, is left as it is.
  report.bbox = 0;
  const figs = elems.filter((e) => ['Figure', 'Formula'].includes(role(e.d)));
  if (figs.length) {
    const getForm = (resources, nm) => {
      const r = doc.resolve(resources); const xo = r && doc.resolve(r.get('XObject')); const x = xo && doc.resolve(xo.get(nm));
      if (!(x instanceof Stream)) return null;
      if (isName(x.dict.get('Subtype'), 'Image')) return { image: true };
      const m = doc.resolve(x.dict.get('Matrix'));
      return { data: doc.streamData(x).toString('latin1'), matrix: Array.isArray(m) ? m.map((v) => doc.resolve(v)) : null,
        resources: x.dict.get('Resources'), structParents: x.dict.get('StructParents') };
    };
    const boxes = new Map(); const pageOfKey = new Map();
    for (const p of pages) {
      const c = p.d.get('Contents'); const list = (Array.isArray(c) ? c : [c]).filter(Boolean);
      const data = list.map((r) => doc.streamData(doc.resolve(r)).toString('latin1')).join('\n');
      let res = p.d.get('Resources'); let par = p.d.get('Parent');
      while (!res && par) { const pd = doc.resolve(par); res = pd.get('Resources'); par = pd.get('Parent'); }
      for (const [k, b] of markedBoxes(data, res, p.d.get('StructParents'), getForm)) { boxes.set(k, b); pageOfKey.set(k, p.ref.n); }
    }
    for (const e of figs) {
      const keys = [];
      for (const k of kidsOf(doc, e.d)) {
        const kd = k instanceof Ref ? doc.resolve(k) : k;
        if (typeof kd === 'number') keys.push(`${spOfPage.get(e.pg && e.pg.n)}/${kd}`);
        else if (kd instanceof Dict && isName(kd.get('Type'), 'MCR')) {
          const stm = kd.get('Stm'); const pg = kd.get('Pg') || e.pg;
          keys.push(`${stm ? doc.resolve(stm).dict.get('StructParents') : spOfPage.get(pg && pg.n)}/${kd.get('MCID')}`);
        }
      }
      const found = keys.filter((k) => boxes.has(k));
      if (!found.length || found.length !== keys.length || new Set(found.map((k) => pageOfKey.get(k))).size !== 1) continue;
      const b = found.map((k) => boxes.get(k)).reduce((a, x) => [Math.min(a[0], x[0]), Math.min(a[1], x[1]), Math.max(a[2], x[2]), Math.max(a[3], x[3])]);
      if (!(b[2] > b[0] && b[3] > b[1])) continue;
      const attr = new Dict().set('O', name('Layout')).set('BBox', b.map((v) => Math.round(v * 100) / 100));
      const prev = e.d.get('A'); e.d.set('A', prev == null ? attr : [].concat(prev, attr));
      doc.touch(e.ref); report.bbox++;
    }
  }

  // 4. Heading levels: first heading H1, no skipped levels (structure only; the page does not change).
  const stack = [];
  for (const e of elems) {
    const m = /^H([1-6])$/.exec(role(e.d)); if (!m) continue;
    const lvl = Number(m[1]);
    while (stack.length && stack[stack.length - 1].orig >= lvl) stack.pop();
    const nl = (stack.length ? stack[stack.length - 1].nl : 0) + 1;
    stack.push({ orig: lvl, nl });
    if (nl !== lvl) { e.d.set('S', name('H' + nl)); doc.touch(e.ref); report.headings++; }
  }

  // Parent tree written back flat.
  const keys = [...parentTree.keys()].sort((a, b) => a - b); const nums = [];
  for (const k of keys) nums.push(k, parentTree.get(k));
  const npt = new Dict().set('Nums', nums);
  if (ptRef instanceof Ref) doc.put(ptRef, npt); else { str.set('ParentTree', npt); doc.touch(strRef); }

  // 5. Link annotations need a description.
  const links = opts.links || new Map();
  for (const p of pages) {
    const annots = doc.resolve(p.d.get('Annots')) || [];
    for (const aref of annots) {
      const a = doc.resolve(aref); if (!isName(a.get('Subtype'), 'Link') || a.get('Contents')) continue;
      const act = doc.resolve(a.get('A')); const uri = act && decodeText(act.get('URI'));
      const dest = a.get('Dest'); const destName = dest instanceof Name ? dest.v : dest && dest.b ? decodeText(dest) : null;
      const text = (uri && links.get(uri)) || (destName && links.get('#' + destName)) || uri || 'Link within this document';
      a.set('Contents', textString(text));
      if (aref instanceof Ref) doc.touch(aref); else doc.touch(p.ref);
      report.links++;
    }
  }

  // 6. Artifacts: anything painted outside marked content.
  const done = new Set();
  const fixStream = (holderRef, stream, resources) => {
    const xo = doc.resolve(resources && doc.resolve(resources).get('XObject'));
    const kindOf = (nm) => {
      const r = xo && xo.get(nm); const x = doc.resolve(r); if (!(x instanceof Stream)) return null;
      if (isName(x.dict.get('Subtype'), 'Image')) return 'image';
      return hasMarkedContent(doc.streamData(x).toString('latin1')) ? 'tagged' : 'untagged';
    };
    const src = doc.streamData(stream).toString('latin1');
    const { out, wrapped, forms } = wrapArtifacts(src, kindOf);
    if (wrapped) { doc.setStreamData(stream, Buffer.from(out, 'latin1')); doc.touch(holderRef); report.artifacts += wrapped; }
    for (const f of forms) {
      const r = xo.get(f); if (!(r instanceof Ref) || done.has(r.n)) continue; done.add(r.n);
      const fx = doc.resolve(r); fixStream(r, fx, fx.dict.get('Resources') || resources);
    }
  };
  for (const p of pages) {
    const c = p.d.get('Contents'); const list = Array.isArray(c) ? c : [c];
    let res = p.d.get('Resources'); let par = p.d.get('Parent');
    while (!res && par) { const pd = doc.resolve(par); res = pd.get('Resources'); par = pd.get('Parent'); }
    for (const cr of list) { if (!(cr instanceof Ref) || done.has(cr.n)) continue; done.add(cr.n); fixStream(cr, doc.resolve(cr), res); }
  }
  return { pdf: doc.save(), report };
}

module.exports = { fixup, CREATOR_MARK };
