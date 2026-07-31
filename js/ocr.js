// グリフ辞書照合 OCR
// 辞書形式: { version: 1, glyphs: { "<key>": "<label>" } }
//   label は1文字とは限らない(AA連結の合字は "ti" 等)。空文字 "" は「無視するアイコン」。
import { hammingBits } from './imgproc.js';

const SPACE_GAP = 4;       // これ以上のx間隔で空白1つ
const SPACE_GAP_DIGIT = 6; // 数字同士は'1'の字間(4px)が空白に見えるため閾値を上げる
const HAMMING_MAX = 3; // 同サイズ照合の許容ビット差

function decodeKey(key) {
  const m = /^(\d+)x(\d+):([0-9a-f]+)(?::([TB]))?$/.exec(key);
  if (!m) return null;
  const w = +m[1], h = +m[2];
  const bits = new Uint8Array(w * h);
  const hex = m[3];
  for (let i = 0; i < bits.length; i++) {
    const nib = parseInt(hex[i >> 2], 16);
    bits[i] = (nib >> (3 - (i & 3))) & 1;
  }
  return { w, h, bits, flag: m[4] || '' };
}

export class GlyphBank {
  constructor(json) {
    this.glyphs = {};
    this.bySize = new Map(); // "WxH:flag" -> [{bits,label,key}]
    if (json && json.glyphs) for (const [k, v] of Object.entries(json.glyphs)) this.add(k, v, false);
  }
  add(key, label, rebuild = true) {
    this.glyphs[key] = label;
    const d = decodeKey(key);
    if (d) {
      const sk = `${d.w}x${d.h}:${d.flag}`;
      if (!this.bySize.has(sk)) this.bySize.set(sk, []);
      this.bySize.get(sk).push({ bits: d.bits, label, key });
    }
  }
  lookup(key) {
    if (key in this.glyphs) return { label: this.glyphs[key], exact: true };
    const d = decodeKey(key);
    if (!d) return null;
    const cands = this.bySize.get(`${d.w}x${d.h}:${d.flag}`);
    if (!cands) return null;
    let best = null, bestD = HAMMING_MAX + 1;
    for (const c of cands) {
      const dist = hammingBits(d.bits, c.bits);
      if (dist < bestD) { bestD = dist; best = c; }
    }
    return best ? { label: best.label, exact: false, dist: bestD } : null;
  }
  toJSON() {
    return { version: 1, glyphs: this.glyphs };
  }
  get size() { return Object.keys(this.glyphs).length; }
}

// 1行を認識。戻り値 {text, chars:[{ch,color,x0,x1}], unknowns:[glyph]}
export function recognizeLine(line, bank) {
  // 先に全グリフを認識してから、隣接ラベルの文脈で空白を決める
  const hits = line.glyphs.map((g) => ({ g, hit: bank.lookup(g.key) }));
  const chars = [];
  const unknowns = [];
  let prev = null, prevLast = '';
  for (const { g, hit } of hits) {
    const label = hit ? hit.label : '�';
    if (label === '') { prev = g; continue; } // 無視アイコンは空白判定にも関与させない
    if (prev) {
      const gap = g.x0 - prev.x1 - 1;
      const bothDigits = /[0-9]/.test(prevLast) && /[0-9]/.test(label[0]);
      // 小文字→大文字の語境界はVの左オーバーハング等で字間が詰まる
      const caseBoundary = /[a-z]/.test(prevLast) && /[A-Z]/.test(label[0]);
      const th = bothDigits ? SPACE_GAP_DIGIT : caseBoundary ? SPACE_GAP - 1 : SPACE_GAP;
      if (gap >= th) {
        chars.push({ ch: ' ', color: 'none', x0: prev.x1 + 1, x1: g.x0 - 1 });
      }
    }
    if (!hit) {
      unknowns.push(g);
      chars.push({ ch: '�', color: g.color, x0: g.x0, x1: g.x1, glyph: g });
    } else {
      for (const ch of label) chars.push({ ch, color: g.color, x0: g.x0, x1: g.x1 });
    }
    prev = g;
    prevLast = label[label.length - 1];
  }
  // 先頭/末尾の空白除去
  while (chars.length && chars[0].ch === ' ') chars.shift();
  while (chars.length && chars[chars.length - 1].ch === ' ') chars.pop();
  return { text: chars.map((c) => c.ch).join(''), chars, unknowns };
}

// ツールチップ全行を認識
export function recognizeLines(lines, bank) {
  return lines.map((ln) => {
    const r = recognizeLine(ln, bank);
    return { ...ln, text: r.text, chars: r.chars, unknowns: r.unknowns };
  });
}
