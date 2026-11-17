// Content-stream rewriting: everything painted outside marked content becomes an /Artifact
// (page backgrounds, callout and quote borders, rules). Tagged content is left byte for byte.
const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);
const PATH_BUILD = new Set(['m', 'l', 'c', 'v', 'y', 'h', 're']);
const PATH_PAINT = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const TEXT_SHOW = new Set(['Tj', 'TJ', "'", '"']);

// Splits a content stream (latin1 string) into operators. Each op carries [start, end) covering its operands.
function tokenize(s) {
  const ops = []; let i = 0, opStart = -1; let lastName = null, firstName = null;
  const n = s.length;
  while (i < n) {
    const c = s.charCodeAt(i);
    if (WS.has(c)) { i++; continue; }
    if (opStart < 0) opStart = i;
    if (c === 0x25) { while (i < n && s[i] !== '\n' && s[i] !== '\r') i++; continue; }
    if (c === 0x28) { let d = 0; for (; i < n; i++) { const ch = s[i]; if (ch === '\\') { i++; continue; } if (ch === '(') d++; else if (ch === ')' && --d === 0) { i++; break; } } continue; }
    if (c === 0x3c && s[i + 1] === '<') { i += 2; continue; }
    if (c === 0x3e && s[i + 1] === '>') { i += 2; continue; }
    if (c === 0x3c) { i = s.indexOf('>', i) + 1; continue; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { i++; continue; }
    if (c === 0x2f) { let e = i + 1; while (e < n && !WS.has(s.charCodeAt(e)) && !DELIM.has(s.charCodeAt(e))) e++; lastName = s.slice(i + 1, e); if (firstName == null) firstName = lastName; i = e; continue; }
    let e = i; while (e < n && !WS.has(s.charCodeAt(e)) && !DELIM.has(s.charCodeAt(e))) e++;
    const t = s.slice(i, e); i = e;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t) || t === 'true' || t === 'false' || t === 'null') continue;
    if (t === 'BI') { // inline image: skip to EI after ID
      const id = s.indexOf('ID', i); let p = id + 3;
      for (;;) { const k = s.indexOf('EI', p); if (k < 0) { p = n; break; } if (WS.has(s.charCodeAt(k - 1)) && (k + 2 >= n || WS.has(s.charCodeAt(k + 2)))) { p = k + 2; break; } p = k + 2; }
      ops.push({ op: 'BI', start: opStart, end: p }); i = p; opStart = -1; lastName = firstName = null; continue;
    }
    ops.push({ op: t, start: opStart, end: i, name: lastName, tag: firstName });
    opStart = -1; lastName = firstName = null;
  }
  return ops;
}

// hasMarked(xobjName) -> 'tagged' | 'untagged' | 'image' | null
// Returns { out, wrapped, forms: names of tagged forms painted outside marked content (to rewrite in turn) }
function wrapArtifacts(s, xobjKind) {
  const ops = tokenize(s);
  let depth = 0, pathFrom = -1, last = 0, wrapped = 0; const forms = new Set();
  const out = [];
  const emit = (a, b) => { out.push(s.slice(a, b)); };
  const art = (a, b) => { out.push('\n/Artifact BMC\n', s.slice(a, b).replace(/^\s+/, ''), '\nEMC\n'); wrapped++; };
  let openArt = false; // a top-level marked sequence that is neither tagged (MCID) nor an Artifact
  for (const o of ops) {
    if (o.op === 'BDC' || o.op === 'BMC') {
      if (depth === 0 && o.tag !== 'Artifact' && !/\/MCID\b/.test(s.slice(o.start, o.end))) {
        emit(last, o.start); out.push('\n/Artifact BMC\n'); last = o.start; openArt = true; wrapped++;
      }
      depth++; continue;
    }
    if (o.op === 'EMC') {
      depth = Math.max(0, depth - 1);
      if (depth === 0 && openArt) { emit(last, o.end); out.push('\nEMC\n'); last = o.end; openArt = false; }
      continue;
    }
    if (depth > 0) continue;
    if (PATH_BUILD.has(o.op)) { if (pathFrom < 0) { emit(last, o.start); last = pathFrom = o.start; } continue; }
    if (o.op === 'W' || o.op === 'W*') continue;
    if (o.op === 'n') { pathFrom = -1; continue; }
    if (PATH_PAINT.has(o.op)) { const a = pathFrom >= 0 ? pathFrom : o.start; emit(last, a); art(a, o.end); last = o.end; pathFrom = -1; continue; }
    if (TEXT_SHOW.has(o.op) || o.op === 'sh' || o.op === 'BI') { emit(last, o.start); art(o.start, o.end); last = o.end; continue; }
    if (o.op === 'Do') {
      const kind = xobjKind(o.name);
      if (kind === 'tagged') { forms.add(o.name); continue; }
      emit(last, o.start); art(o.start, o.end); last = o.end; continue;
    }
  }
  emit(last, s.length);
  return { out: out.join(''), wrapped, forms };
}

const hasMarkedContent = (s) => tokenize(s).some((o) => o.op === 'BDC' || o.op === 'BMC');

module.exports = { tokenize, wrapArtifacts, hasMarkedContent, PATH_BUILD, PATH_PAINT };

// Page-space bounding boxes of marked content. Walks page content and the forms it paints, tracking the CTM, and
// collects path points and image unit squares inside each MCID. Returns Map("structParents/mcid" -> [x0, y0, x1, y1]).
// getForm(resources, name) -> { data, matrix, resources, structParents, image } | null.
const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
function markedBoxes(pageData, pageResources, pageSP, getForm) {
  const boxes = new Map();
  const add = (keys, ctm, x, y) => {
    const px = x * ctm[0] + y * ctm[2] + ctm[4], py = x * ctm[1] + y * ctm[3] + ctm[5];
    for (const k of keys) { const b = boxes.get(k); if (!b) boxes.set(k, [px, py, px, py]); else { b[0] = Math.min(b[0], px); b[1] = Math.min(b[1], py); b[2] = Math.max(b[2], px); b[3] = Math.max(b[3], py); } }
  };
  const run = (s, resources, sp, ctm0, depthLeft, inherited) => {
    let ctm = ctm0; const saved = []; const open = []; let path = []; // open: key or null per BDC/BMC
    const nums = (o) => (s.slice(o.start, o.end).match(/[+-]?(?:\d+\.?\d*|\.\d+)/g) || []).map(Number);
    for (const o of tokenize(s)) {
      if (o.op === 'q') saved.push(ctm);
      else if (o.op === 'Q') ctm = saved.length ? saved.pop() : ctm0;
      else if (o.op === 'cm') { const n = nums(o).slice(-6); if (n.length === 6) ctm = mul(n, ctm); }
      else if (o.op === 'BDC' || o.op === 'BMC') { const m = /\/MCID\s+(\d+)/.exec(s.slice(o.start, o.end)); open.push(m && sp != null ? `${sp}/${m[1]}` : null); }
      else if (o.op === 'EMC') open.pop();
      else {
        const keys = [...inherited, ...open.filter((k) => k)];
        if (o.op === 'Do') {
          const f = getForm(resources, o.name); if (!f) continue;
          if (f.image) { if (keys.length) for (const [x, y] of [[0, 0], [1, 0], [0, 1], [1, 1]]) add(keys, ctm, x, y); }
          else if (depthLeft > 0) run(f.data, f.resources || resources, f.structParents, mul(f.matrix || [1, 0, 0, 1, 0, 0], ctm), depthLeft - 1, keys);
          continue;
        }
        if (!keys.length) { if (PATH_PAINT.has(o.op) || o.op === 'n') path = []; continue; }
        const n = nums(o);
        // Path points count only when the path is painted; a clip path ended by 'n' paints nothing.
        if (o.op === 're' && n.length >= 4) { const [x, y, w, h] = n.slice(-4); path.push([x, y], [x + w, y + h], [x + w, y], [x, y + h]); }
        else if (['m', 'l', 'c', 'v', 'y'].includes(o.op)) { for (let i = 0; i + 1 < n.length; i += 2) path.push([n[i], n[i + 1]]); }
        else if (PATH_PAINT.has(o.op)) { for (const [x, y] of path) add(keys, ctm, x, y); path = []; }
        else if (o.op === 'n') path = [];
      }
    }
  };
  run(pageData, pageResources, pageSP, [1, 0, 0, 1, 0, 0], 4, []);
  return boxes;
}
module.exports.markedBoxes = markedBoxes;
