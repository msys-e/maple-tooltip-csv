// 診断: フレームPNGを本番同一パイプラインで処理し、未知グリフの詳細を出す
//   node test/diag.mjs <png...>
import { readFileSync } from 'node:fs';
import { decodePNG, writeBMP } from './png.mjs';
import { findTooltip, countStars } from '../js/detect.js';
import { segmentLines } from '../js/segment.js';
import { GlyphBank, recognizeLines } from '../js/ocr.js';
import { parseTooltip } from '../js/parse.js';

const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const bank = new GlyphBank(JSON.parse(readFileSync(`${ROOT}data/glyphbank.json`, 'utf-8')));

function decodeKey(key) {
  const m = /^(\d+)x(\d+):([0-9a-f]+)(?::([TB]))?$/.exec(key);
  const w = +m[1], h = +m[2];
  const bits = new Uint8Array(w * h);
  for (let i = 0; i < bits.length; i++) bits[i] = (parseInt(m[3][i >> 2], 16) >> (3 - (i & 3))) & 1;
  return { w, h, bits, flag: m[4] || '' };
}

function nearest(key) {
  const d = decodeKey(key);
  let best = null, bestMis = Infinity;
  for (const [k, label] of Object.entries(bank.glyphs)) {
    const c = decodeKey(k);
    if (Math.abs(c.w - d.w) > 2 || Math.abs(c.h - d.h) > 2 || c.flag !== d.flag) continue;
    for (let ox = -2; ox <= 2; ox++) {
      for (let oy = -2; oy <= 2; oy++) {
        let mis = 0;
        const W = Math.max(d.w, c.w + ox), H = Math.max(d.h, c.h + oy);
        for (let y = 0; y < H && mis < bestMis; y++) {
          for (let x = 0; x < W; x++) {
            const a = (x < d.w && y < d.h) ? d.bits[y * d.w + x] : 0;
            const cx = x - ox, cy = y - oy;
            const b = (cx >= 0 && cy >= 0 && cx < c.w && cy < c.h) ? c.bits[cy * c.w + cx] : 0;
            if (a !== b) mis++;
          }
        }
        if (mis < bestMis) { bestMis = mis; best = { label, k }; }
      }
    }
  }
  return best ? `~"${best.label}" mis=${bestMis} (${best.k.split(':')[0]})` : 'no-candidate';
}

for (const path of process.argv.slice(2)) {
  const img = decodePNG(path);
  const bbox = findTooltip(img);
  console.log(`\n== ${path.split(/[\\/]/).pop()} ${img.width}x${img.height} detect=${JSON.stringify(bbox)}`);
  if (bbox.error) continue;
  const crop = { width: bbox.w, height: bbox.h, data: (() => {
    const o = new Uint8ClampedArray(bbox.w * bbox.h * 4);
    for (let y = 0; y < bbox.h; y++) {
      const s = ((bbox.y + y) * img.width + bbox.x) * 4;
      o.set(img.data.subarray(s, s + bbox.w * 4), y * bbox.w * 4);
    }
    return o;
  })() };
  const rec = recognizeLines(segmentLines(crop), bank);
  const item = parseTooltip(rec, countStars(img, bbox));
  const nameY = item._name_y ?? -1;
  let unk = 0, junkUnk = 0;
  for (const ln of rec) {
    if (nameY >= 0 && ln.y1 < nameY - 2) { junkUnk += ln.unknowns.length; continue; }
    unk += ln.unknowns.length;
    for (const g of ln.unknowns) {
      console.log(` unk ${g.key.padEnd(30)} ${g.color.padEnd(6)} x=${g.x0}-${g.x1} y=${g.y0} line="${ln.text.slice(0, 44)}" ${nearest(g.key)}`);
    }
  }
  console.log(` name="${item.item_name}" stars=${item.star_count} lines=${rec.length} unknowns=${unk} (名前より上のジャンク${junkUnk}件は除外)`);
}
