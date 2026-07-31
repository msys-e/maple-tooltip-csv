// 回帰テストランナー (Node)
//   node test/run.mjs seg            行/グリフ分割の概要 + overlay BMP出力
//   node test/run.mjs label          goldenテキストとの整列で辞書を自動構築 → data/glyphbank.json
//   node test/run.mjs ocr            辞書で全行認識し golden と比較
//   node test/run.mjs parse          パース結果を golden CSV(json) と比較
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { decodePNG, writeBMP } from './png.mjs';
import { findTooltip, countStars } from '../js/detect.js';
import { segmentLines } from '../js/segment.js';
import { GlyphBank, recognizeLines } from '../js/ocr.js';
import { parseTooltip } from '../js/parse.js';
import { itemToRow, COLUMNS } from '../js/csv.js';

const SAMPLES = ['berserked', 'dawn_ring', 'genesis_sword', 'full_daybreak', 'full_mitra'];
const OUT = new URL('./out/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const ROOT = new URL('../', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

function crop(img, bbox) {
  const out = new Uint8ClampedArray(bbox.w * bbox.h * 4);
  for (let y = 0; y < bbox.h; y++) {
    const src = ((bbox.y + y) * img.width + bbox.x) * 4;
    out.set(img.data.subarray(src, src + bbox.w * 4), y * bbox.w * 4);
  }
  return { width: bbox.w, height: bbox.h, data: out };
}

function loadSample(name) {
  const path = existsSync(`${ROOT}samples/${name}.png`)
    ? `${ROOT}samples/${name}.png` : `${ROOT}test/fixtures/${name}.png`;
  const img = decodePNG(path);
  let bbox = findTooltip(img);
  if (bbox.error) {
    console.log(`${name}: findTooltip -> ${bbox.error}`, bbox.bbox || '');
    bbox = { x: 0, y: 0, w: img.width, h: img.height };
  }
  const tip = crop(img, bbox);
  return { img, bbox, tip, stars: countStars(img, bbox), lines: segmentLines(tip) };
}

function drawOverlay(name, tip, lines) {
  const ov = { width: tip.width, height: tip.height, data: new Uint8ClampedArray(tip.data) };
  const box = (x0, y0, x1, y1, r, g, b) => {
    for (let x = x0; x <= x1; x++) {
      for (const y of [y0, y1]) {
        if (y < 0 || y >= ov.height || x < 0 || x >= ov.width) continue;
        const p = (y * ov.width + x) * 4;
        ov.data[p] = r; ov.data[p + 1] = g; ov.data[p + 2] = b;
      }
    }
    for (let y = y0; y <= y1; y++) {
      for (const x of [x0, x1]) {
        if (y < 0 || y >= ov.height || x < 0 || x >= ov.width) continue;
        const p = (y * ov.width + x) * 4;
        ov.data[p] = r; ov.data[p + 1] = g; ov.data[p + 2] = b;
      }
    }
  };
  for (const ln of lines) {
    box(ln.x0 - 2, ln.y0 - 2, ln.x1 + 2, ln.y1 + 2, 255, 0, 0);
    for (const g of ln.glyphs) box(g.x0, g.y0, g.x1, g.y1, 0, 255, 0);
  }
  writeBMP(`${OUT}${name}_seg.bmp`, ov);
}

function goldenLines(name) {
  const p = `${ROOT}test/golden/${name}.txt`;
  if (!existsSync(p)) return null;
  return readFileSync(p, 'utf-8').replace(/\r/g, '').split('\n')
    .filter((l) => !l.startsWith('#') && l.trim().length > 0)
    .map((l) => l.trimEnd());
}

const cmd = process.argv[2] || 'seg';

if (cmd === 'seg') {
  for (const name of SAMPLES) {
    const { tip, stars, lines } = loadSample(name);
    console.log(`\n== ${name} stars=${stars} lines=${lines.length}`);
    for (const ln of lines) {
      const colors = [...new Set(ln.glyphs.map((g) => g.color))].join(',');
      console.log(` y=${String(ln.y0).padStart(3)}-${ln.y1} x=${ln.x0} n=${String(ln.glyphs.length).padStart(2)}` +
        ` ${ln.bullet ? `bullet=${ln.bullet} ` : ''}[${colors}]`);
    }
    drawOverlay(name, tip, lines);
  }
}

// DP整列: 各グリフが 0〜3文字を消費する対応付けを探す
//   0文字消費 = 無視アイコン(§相当)、2-3文字 = AA合字
const foldIl = (s) => s.replace(/I/g, 'l');

function alignLine(glyphs, chars, bank) {
  const n = glyphs.length, m = chars.length;
  const NEG = -1e9;
  const score = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(NEG));
  const from = Array.from({ length: n + 1 }, () => new Int8Array(m + 1));
  score[0][0] = 0;
  for (let i = 0; i < n; i++) {
    const known = bank.glyphs[glyphs[i].key];
    for (let j = 0; j <= m; j++) {
      if (score[i][j] === NEG) continue;
      for (let k = 0; k <= 3; k++) {
        if (j + k > m) break;
        const s = chars.slice(j, j + k).replace(/§/g, '');
        let d;
        if (k === 0) d = known === '' ? 2 : known === undefined ? -4 : -12;
        else if (known !== undefined) d = foldIl(known) === foldIl(s) ? 3 : -12;
        else d = k === 1 ? 0 : -1.5;
        if (score[i][j] + d > score[i + 1][j + k]) {
          score[i + 1][j + k] = score[i][j] + d;
          from[i + 1][j + k] = k;
        }
      }
    }
  }
  if (score[n][m] === NEG) return null;
  // 経路復元
  const consume = new Array(n);
  let j = m;
  for (let i = n; i > 0; i--) {
    consume[i - 1] = from[i][j];
    j -= from[i][j];
  }
  // ミスマッチ(-12)を踏んだ整列は信用しない
  let jj = 0;
  for (let i = 0; i < n; i++) {
    const known = bank.glyphs[glyphs[i].key];
    const s = chars.slice(jj, jj + consume[i]).replace(/§/g, '');
    if (known !== undefined && foldIl(known) !== foldIl(s) && !(consume[i] === 0 && known === '')) return null;
    jj += consume[i];
  }
  return consume;
}

if (cmd === 'label') {
  const bank = new GlyphBank(null);
  const samples = SAMPLES.map((name) => ({ name, lines: loadSample(name).lines, golden: goldenLines(name) }));
  const conflicts = [];
  let round = 0, added = 1;
  const lineState = new Map(); // "name:idx" -> done
  while (added && round < 8) {
    round++;
    added = 0;
    for (const { name, lines, golden } of samples) {
      if (!golden) continue;
      if (golden.length !== lines.length && round === 1) {
        console.log(`${name}: line count mismatch golden=${golden.length} seg=${lines.length}`);
      }
      for (let i = 0; i < Math.min(golden.length, lines.length); i++) {
        const id = `${name}:${i + 1}`;
        if (lineState.get(id) || golden[i].startsWith('!')) continue;
        const chars = golden[i].replace(/ /g, '');
        const glyphs = lines[i].glyphs;
        const consume = alignLine(glyphs, chars, bank);
        if (!consume) continue;
        // 未知グリフの連続runごとに「全て1文字消費」のときだけコミット
        // (merge位置・余剰グリフ位置が曖昧なrunは既知が増える後続roundに委ねる)
        const known = glyphs.map((g) => bank.glyphs[g.key] !== undefined);
        let j = 0, allKnown = true;
        for (let g = 0; g < glyphs.length; ) {
          if (known[g]) { j += consume[g]; g++; continue; }
          let end = g, sum = 0;
          while (end < glyphs.length && !known[end]) { sum += consume[end]; end++; }
          const runLen = end - g;
          // 1:1整列 or run長1(両隣が既知なので消費文字が一意)ならコミット
          if (sum === runLen || runLen === 1) {
            for (let t = g; t < end; t++) {
              const label = chars.slice(j, j + consume[t]).replace(/§/g, '');
              j += consume[t];
              const cur = bank.glyphs[glyphs[t].key];
              if (cur === undefined) { bank.add(glyphs[t].key, label); added++; }
              else if (cur !== label) conflicts.push(`${id}:g${t} key=${glyphs[t].key} kept "${cur}" vs "${label}"`);
            }
          } else {
            for (let t = g; t < end; t++) j += consume[t];
            allKnown = false;
          }
          g = end;
        }
        if (allKnown) lineState.set(id, true);
      }
    }
    console.log(`round ${round}: bank=${bank.size}`);
  }
  const pending = [];
  for (const { name, lines, golden } of samples) {
    if (!golden) continue;
    for (let i = 0; i < Math.min(golden.length, lines.length); i++) {
      if (!lineState.get(`${name}:${i + 1}`) && !golden[i].startsWith('!')) {
        pending.push(` UNRESOLVED ${name}:${i + 1} glyphs=${lines[i].glyphs.length} "${golden[i]}"`);
      }
    }
  }
  pending.forEach((p) => console.log(p));
  if (conflicts.length) { console.log('CONFLICTS:'); conflicts.forEach((c) => console.log(' ' + c)); }
  writeFileSync(`${ROOT}data/glyphbank.json`, JSON.stringify(bank.toJSON(), null, 1));
  console.log(`wrote data/glyphbank.json (${bank.size} glyphs, unresolved=${pending.length})`);
}

if (cmd === 'dump') {
  const name = process.argv[3];
  const lineNo = +process.argv[4];
  const bankJson = existsSync(`${ROOT}data/glyphbank.json`)
    ? JSON.parse(readFileSync(`${ROOT}data/glyphbank.json`, 'utf-8')) : null;
  const bank = new GlyphBank(bankJson);
  const { tip, lines } = loadSample(name);
  const ln = lines[lineNo - 1];
  console.log(`line ${lineNo}: y=${ln.y0}-${ln.y1} bullet=${ln.bullet}`);
  for (const g of ln.glyphs) {
    const hit = bank.lookup(g.key);
    console.log(` x=${String(g.x0).padStart(3)}-${String(g.x1).padEnd(3)} y=${g.y0}-${g.y1}` +
      ` ${g.color.padEnd(6)} ${JSON.stringify(hit ? hit.label : null).padEnd(6)} ${g.key}`);
  }
  const pad = 3;
  const cropImg = {
    width: tip.width, height: ln.y1 - ln.y0 + 1 + pad * 2,
    data: (() => {
      const out = new Uint8ClampedArray(tip.width * (ln.y1 - ln.y0 + 1 + pad * 2) * 4);
      for (let y = 0; y < ln.y1 - ln.y0 + 1 + pad * 2; y++) {
        const sy = ln.y0 - pad + y;
        if (sy < 0 || sy >= tip.height) continue;
        out.set(tip.data.subarray(sy * tip.width * 4, (sy + 1) * tip.width * 4), y * tip.width * 4);
      }
      return out;
    })(),
  };
  // 4x拡大
  const big = { width: cropImg.width * 4, height: cropImg.height * 4, data: new Uint8ClampedArray(cropImg.width * 4 * cropImg.height * 4 * 4) };
  for (let y = 0; y < big.height; y++) {
    for (let x = 0; x < big.width; x++) {
      const s = (((y / 4) | 0) * cropImg.width + ((x / 4) | 0)) * 4, d = (y * big.width + x) * 4;
      big.data[d] = cropImg.data[s]; big.data[d + 1] = cropImg.data[s + 1]; big.data[d + 2] = cropImg.data[s + 2]; big.data[d + 3] = 255;
    }
  }
  writeBMP(`${OUT}${name}_L${lineNo}.bmp`, big);
  console.log(`wrote ${OUT}${name}_L${lineNo}.bmp`);
}

if (cmd === 'ocr' || cmd === 'parse') {
  const bank = new GlyphBank(JSON.parse(readFileSync(`${ROOT}data/glyphbank.json`, 'utf-8')));
  let pass = 0, fail = 0;
  for (const name of SAMPLES) {
    const { lines, stars } = loadSample(name);
    const rec = recognizeLines(lines, bank);
    if (cmd === 'ocr') {
      const golden = goldenLines(name);
      console.log(`\n== ${name}`);
      // I/l は同一字形のため比較時に正規化。§(アイコン)と!(スキップ)行も処理
      const fold = (s) => s.replace(/I/g, 'l').replace(/§/g, '').replace(/\s+/g, ' ').trim();
      for (let i = 0; i < rec.length; i++) {
        if (golden?.[i]?.startsWith('!')) { pass++; continue; }
        const got = fold(rec[i].text);
        const want = golden?.[i] !== undefined ? fold(golden[i]) : '(no golden)';
        const mark = got === want ? 'OK' : 'NG';
        if (mark === 'OK') pass++; else fail++;
        if (mark === 'NG') console.log(` NG L${i + 1}\n   got : "${got}"\n   want: "${want}"`);
      }
    } else {
      const item = parseTooltip(rec, stars);
      const gp = `${ROOT}test/golden/${name}.item.json`;
      console.log(`\n== ${name}`);
      if (existsSync(gp)) {
        const want = JSON.parse(readFileSync(gp, 'utf-8'));
        let bad = 0;
        for (const [k, v] of Object.entries(want)) {
          const got = k === 'extra_lines' ? (item.extra_lines || []).join('|') : item[k];
          if (String(got) !== String(v)) {
            bad++;
            console.log(` NG ${k}: got=${JSON.stringify(got)} want=${JSON.stringify(v)}`);
          }
        }
        if (!bad) { pass++; console.log(' all fields OK'); } else fail++;
      } else {
        const row = {};
        itemToRow(item).forEach((v, i) => { if (v !== undefined && v !== '') row[COLUMNS[i]] = v; });
        delete row.timestamp;
        delete row.raw_text;
        console.log(JSON.stringify(row, null, 1));
      }
    }
  }
  console.log(`\n${cmd}: pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
}
