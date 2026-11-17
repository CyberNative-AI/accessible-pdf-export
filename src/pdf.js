// Minimal PDF object reader and incremental-update writer.
// Scope: the files Chromium (Skia/PDF) writes when it prints a page: classic xref tables, no object streams.
// Anything else is refused with an error rather than guessed at.
const zlib = require('zlib');

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

class Name { constructor(v) { this.v = v; } }
class Ref { constructor(n, g) { this.n = n; this.g = g; } }
class Str { constructor(b) { this.b = b; } }          // raw bytes
class Dict { constructor(m) { this.m = m || new Map(); }
  get(k) { return this.m.get(k); } set(k, v) { this.m.set(k, v); return this; } has(k) { return this.m.has(k); } delete(k) { this.m.delete(k); } }
class Stream { constructor(dict, data) { this.dict = dict; this.data = data; } }
const KW = (v) => ({ kw: v });

const name = (v) => new Name(v);
const isName = (x, v) => x instanceof Name && (v === undefined || x.v === v);

function textString(s) {
  if (/^[\x20-\x7e]*$/.test(s)) return new Str(Buffer.from(s, 'latin1'));
  const b = Buffer.alloc(2 + s.length * 2); b[0] = 0xfe; b[1] = 0xff;
  for (let i = 0; i < s.length; i++) b.writeUInt16BE(s.charCodeAt(i), 2 + i * 2);
  return new Str(b);
}
function decodeText(str) {
  if (!(str instanceof Str)) return '';
  const b = str.b;
  if (b.length >= 2 && b[0] === 0xfe && b[1] === 0xff) { let s = ''; for (let i = 2; i + 1 < b.length; i += 2) s += String.fromCharCode(b.readUInt16BE(i)); return s; }
  return b.toString('latin1');
}

class Lexer {
  constructor(buf, pos = 0) { this.b = buf; this.p = pos; }
  skip() {
    const b = this.b;
    for (;;) {
      while (this.p < b.length && WS.has(b[this.p])) this.p++;
      if (b[this.p] === 0x25) { while (this.p < b.length && b[this.p] !== 0x0a && b[this.p] !== 0x0d) this.p++; continue; }
      return;
    }
  }
  token() {
    this.skip();
    const b = this.b; const c = b[this.p];
    if (this.p >= b.length) return null;
    if (c === 0x2f) { // name
      let s = this.p + 1, e = s; while (e < b.length && !WS.has(b[e]) && !DELIM.has(b[e])) e++;
      this.p = e;
      return name(b.toString('latin1', s, e).replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))));
    }
    if (c === 0x28) return this.literal();
    if (c === 0x3c) {
      if (b[this.p + 1] === 0x3c) { this.p += 2; return KW('<<'); }
      const e = b.indexOf(0x3e, this.p); const hex = b.toString('latin1', this.p + 1, e).replace(/\s+/g, '');
      this.p = e + 1; return new Str(Buffer.from(hex.length % 2 ? hex + '0' : hex, 'hex'));
    }
    if (c === 0x3e && b[this.p + 1] === 0x3e) { this.p += 2; return KW('>>'); }
    if (c === 0x5b || c === 0x5d) { this.p++; return KW(String.fromCharCode(c)); }
    let e = this.p; while (e < b.length && !WS.has(b[e]) && !DELIM.has(b[e])) e++;
    const t = b.toString('latin1', this.p, e); this.p = e;
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(t)) return Number(t);
    if (t === 'true') return true; if (t === 'false') return false; if (t === 'null') return null;
    return KW(t);
  }
  literal() {
    const b = this.b; let p = this.p + 1, depth = 1; const out = [];
    while (p < b.length) {
      const c = b[p];
      if (c === 0x5c) {
        const n = b[p + 1];
        const map = { 0x6e: 10, 0x72: 13, 0x74: 9, 0x62: 8, 0x66: 12, 0x28: 40, 0x29: 41, 0x5c: 92 };
        if (n in map) { out.push(map[n]); p += 2; continue; }
        if (n === 0x0d) { p += b[p + 2] === 0x0a ? 3 : 2; continue; }
        if (n === 0x0a) { p += 2; continue; }
        if (n >= 0x30 && n <= 0x37) { let o = 0, k = 0; p++; while (k < 3 && b[p] >= 0x30 && b[p] <= 0x37) { o = o * 8 + b[p] - 0x30; p++; k++; } out.push(o & 255); continue; }
        p++; continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29 && --depth === 0) { p++; break; }
      out.push(c); p++;
    }
    this.p = p; return new Str(Buffer.from(out));
  }
  // value with refs (n g R) folded
  value(tok = this.token()) {
    if (tok && tok.kw === '<<') {
      const d = new Dict();
      for (;;) { const k = this.token(); if (k && k.kw === '>>') return d; if (!(k instanceof Name)) throw new Error('bad dict key'); d.set(k.v, this.value()); }
    }
    if (tok && tok.kw === '[') {
      const a = [];
      for (;;) { const t = this.token(); if (t && t.kw === ']') return a; a.push(this.value(t)); }
    }
    if (typeof tok === 'number' && Number.isInteger(tok)) {
      const save = this.p; const t2 = this.token();
      if (typeof t2 === 'number' && Number.isInteger(t2)) { const t3 = this.token(); if (t3 && t3.kw === 'R') return new Ref(tok, t2); }
      this.p = save;
    }
    return tok;
  }
}

class PdfDoc {
  constructor(buf) {
    this.buf = buf; this.offsets = new Map(); this.cache = new Map(); this.dirty = new Set();
    const tail = buf.toString('latin1', Math.max(0, buf.length - 1024));
    const m = tail.match(/startxref\s+(\d+)\s+%%EOF\s*$/);
    if (!m) throw new Error('no startxref');
    this.startxref = Number(m[1]);
    let x = this.startxref; let first = true;
    while (x != null) {
      const lx = new Lexer(buf, x); const kw = lx.token();
      if (!kw || kw.kw !== 'xref') throw new Error('unsupported PDF: cross-reference stream (only Chromium output is supported)');
      for (;;) {
        const save = lx.p; const t = lx.token();
        if (t && t.kw === 'trailer') break;
        if (typeof t !== 'number') { lx.p = save; throw new Error('bad xref'); }
        const count = lx.token();
        lx.skip();
        for (let i = 0; i < count; i++) {
          const line = buf.toString('latin1', lx.p, lx.p + 20); lx.p += 20;
          const [off, , typ] = line.trim().split(/\s+/);
          const n = t + i;
          if (typ === 'n' && !this.offsets.has(n)) this.offsets.set(n, Number(off));
        }
      }
      const tr = lx.value();
      if (first) { this.trailer = tr; first = false; }
      x = tr.get('Prev') ?? null;
    }
    this.size = this.trailer.get('Size');
  }
  get(ref) {
    const n = ref instanceof Ref ? ref.n : ref;
    if (this.cache.has(n)) return this.cache.get(n);
    const off = this.offsets.get(n); if (off == null) return null;
    const lx = new Lexer(this.buf, off);
    lx.token(); lx.token(); const o = lx.token(); if (!o || o.kw !== 'obj') throw new Error('bad object ' + n);
    let v = lx.value();
    const save = lx.p; const t = lx.token();
    if (t && t.kw === 'stream') {
      let p = lx.p; if (this.buf[p] === 0x0d) p++; if (this.buf[p] === 0x0a) p++;
      const len = this.resolve(v.get('Length'));
      v = new Stream(v, this.buf.subarray(p, p + len));
    } else lx.p = save;
    this.cache.set(n, v); return v;
  }
  resolve(v) { return v instanceof Ref ? this.get(v) : v; }
  touch(ref) { this.dirty.add(ref instanceof Ref ? ref.n : ref); }
  add(v) { const n = this.size++; this.cache.set(n, v); this.dirty.add(n); return new Ref(n, 0); }
  put(ref, v) { const n = ref instanceof Ref ? ref.n : ref; this.cache.set(n, v); this.dirty.add(n); }
  get catalog() { return this.get(this.trailer.get('Root')); }
  streamData(s) {
    const f = s.dict.get('Filter');
    const filters = f == null ? [] : Array.isArray(f) ? f : [f];
    let d = s.data;
    for (const x of filters) {
      if (isName(x, 'FlateDecode')) d = zlib.inflateSync(d);
      else throw new Error('unsupported stream filter ' + (x && x.v));
    }
    return d;
  }
  setStreamData(s, data, compress = true) {
    s.dict.delete('DecodeParms');
    if (compress) { s.data = zlib.deflateSync(data); s.dict.set('Filter', name('FlateDecode')); }
    else { s.data = data; s.dict.delete('Filter'); }
  }
  save() {
    const parts = [this.buf]; let pos = this.buf.length;
    const push = (b) => { parts.push(b); pos += b.length; };
    push(Buffer.from('\n', 'latin1'));
    const nums = [...this.dirty].sort((a, b) => a - b); const offs = new Map();
    for (const n of nums) {
      offs.set(n, pos);
      push(Buffer.from(`${n} 0 obj\n`, 'latin1'));
      push(serialize(this.cache.get(n)));
      push(Buffer.from('\nendobj\n', 'latin1'));
    }
    const xref = pos; let s = 'xref\n';
    for (let i = 0; i < nums.length;) {
      let j = i; while (j + 1 < nums.length && nums[j + 1] === nums[j] + 1) j++;
      s += `${nums[i]} ${j - i + 1}\n`;
      for (let k = i; k <= j; k++) s += `${String(offs.get(nums[k])).padStart(10, '0')} 00000 n\r\n`;
      i = j + 1;
    }
    const tr = new Dict(new Map(this.trailer.m)); tr.set('Size', this.size); tr.set('Prev', this.startxref);
    push(Buffer.from(s + 'trailer\n', 'latin1')); push(serialize(tr));
    push(Buffer.from(`\nstartxref\n${xref}\n%%EOF\n`, 'latin1'));
    return Buffer.concat(parts);
  }
}

function num(x) {
  if (Number.isInteger(x)) return String(x);
  let s = Math.abs(x) < 1e-6 ? x.toFixed(10) : String(x);
  if (/e/.test(s)) s = x.toFixed(10);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
function nameBytes(v) {
  let s = '/';
  for (const ch of Buffer.from(v, 'latin1')) s += (ch < 0x21 || ch > 0x7e || DELIM.has(ch) || ch === 0x23) ? '#' + ch.toString(16).padStart(2, '0') : String.fromCharCode(ch);
  return s;
}
function ser(v) {
  if (v === null || v === undefined) return 'null';
  if (v === true) return 'true'; if (v === false) return 'false';
  if (typeof v === 'number') return num(v);
  if (v instanceof Name) return nameBytes(v.v);
  if (v instanceof Ref) return `${v.n} ${v.g} R`;
  if (v instanceof Str) return '<' + v.b.toString('hex') + '>';
  if (Array.isArray(v)) return '[' + v.map(ser).join(' ') + ']';
  if (v instanceof Dict) return '<<' + [...v.m].map(([k, x]) => nameBytes(k) + ' ' + ser(x)).join(' ') + '>>';
  throw new Error('cannot serialize ' + typeof v);
}
function serialize(v) {
  if (v instanceof Stream) {
    v.dict.set('Length', v.data.length);
    return Buffer.concat([Buffer.from(ser(v.dict) + '\nstream\n', 'latin1'), v.data, Buffer.from('\nendstream', 'latin1')]);
  }
  return Buffer.from(ser(v), 'latin1');
}

module.exports = { PdfDoc, Lexer, Name, Ref, Str, Dict, Stream, name, isName, textString, decodeText };
