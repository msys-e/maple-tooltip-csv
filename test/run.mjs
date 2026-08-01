// 回帰テストランナー (Node)
//   node test/run.mjs seg            行/グリフ分割の概要 + overlay BMP出力
//   node test/run.mjs label          goldenテキストとの整列で辞書を自動構築 → data/glyphbank.json
//   node test/run.mjs ocr            辞書で全行認識し golden と比較
//   node test/run.mjs parse          パース結果を golden CSV(json) と比較
//   node test/run.mjs scouter        maplescouter連携(差分生成・ブックマークレット)の単体テスト
//   node test/run.mjs parsestat      STAT画面のラベル→キー変換の単体テスト(画像不要)
//   node test/run.mjs statdetect     STAT画面/ポップアップの矩形検出と行分割の回帰
//   node test/run.mjs statocr        STAT画面 検出→分割→OCR→パース の通し回帰
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { decodePNG, writeBMP } from './png.mjs';
import { findTooltip, countStars } from '../js/detect.js';
import { segmentLines } from '../js/segment.js';
import { GlyphBank, recognizeLines } from '../js/ocr.js';
import { parseTooltip } from '../js/parse.js';
import { itemToRow, COLUMNS } from '../js/csv.js';
import { buildDiff, applyDiff, buildBookmarklet, PRESET_KEY, SCOUTER_FIELDS } from '../js/scouter.js';
import { parseStatWindow, parseStatPopup, parseLevel, STAT_LABELS, numbersIn } from '../js/parsestat.js';
import { findStatWindow, findStatPopup, findLevelBadge } from '../js/detectstat.js';

const SAMPLES = [
  'berserked', 'dawn_ring', 'genesis_sword', 'full_daybreak', 'full_mitra',
  'endless_terror', 'dawn_ring_b', 'superior_gollux', 'magic_eyepatch',
  'source_of_suffering', 'commanding_force', 'daybreak_pendant', 'dreamy_belt', 'cursed_spellbook',
  'eternal_helm', 'eternal_armor', 'eternal_pants', 'arcane_shoulder', 'arcane_cape',
  'arcane_gloves', 'arcane_shoes', 'arcane_shoes_b', 'black_heart', 'live_eternal_helm', 'live_princess_gem',
];
// STAT画面はラベルのフォントが装備ツールチップと別物なので、同じ label フローで
// グリフを学習させる(数字は既存グリフと共通なので実際に増えるのは英大文字が中心)
const STAT_SAMPLES = ['stat_window'];
// レベルバッジはさらに別サイズのフォント。数字だけ学習させる
const LEVEL_SAMPLES = ['level_badge'];
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
  const linesAll = segmentLines(tip);
  // label/ocr のgolden整列は星列を除いたテキスト行に対して行う
  return { img, bbox, tip, stars: countStars(img, bbox), lines: linesAll.filter((l) => !l.isStars), linesAll };
}

// STATウィンドウ用のローダ(検出器だけが違う。星は無いので isStars 判定も不要)
function loadStatSample(name) {
  const img = decodePNG(`${ROOT}test/fixtures/${name}.png`);
  const bbox = findStatWindow(img);
  if (bbox.error) throw new Error(`${name}: findStatWindow -> ${bbox.error}`);
  const tip = crop(img, bbox);
  const lines = segmentLines(tip);
  return { img, bbox, tip, stars: 0, lines, linesAll: lines };
}

// レベルバッジ用のローダ(検出器だけが違う)
function loadLevelSample(name) {
  const img = decodePNG(`${ROOT}test/fixtures/${name}.png`);
  const bbox = findLevelBadge(img);
  if (bbox.error) throw new Error(`${name}: findLevelBadge -> ${bbox.error}`);
  const tip = crop(img, bbox);
  const lines = segmentLines(tip);
  return { img, bbox, tip, stars: 0, lines, linesAll: lines };
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
        const raw = chars.slice(j, j + k);
        const s = raw.replace(/§/g, '');
        let d;
        if (k === 0) d = known === '' ? 2 : known === undefined ? -4 : -12;
        else if (known !== undefined) d = foldIl(known) === foldIl(s) ? 3 : -12;
        else d = k === 1 ? (raw === '§' ? 1.5 : 0) : -1.5; // §は「この位置に無視グリフ」の明示なので優遇
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
  const samples = [
    ...SAMPLES.map((name) => ({ name, lines: loadSample(name).lines, golden: goldenLines(name) })),
    ...STAT_SAMPLES.map((name) => ({ name, lines: loadStatSample(name).lines, golden: goldenLines(name) })),
    ...LEVEL_SAMPLES.map((name) => ({ name, lines: loadLevelSample(name).lines, golden: goldenLines(name) })),
  ];
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
          // コミット条件: 1:1整列 / run長1(消費が一意) /
          //   run長2で片方が§のみ消費(合字+無視グリフの組。§優遇スコアで整列が一意)
          let jj2 = j;
          let hasSoloIcon = false;
          for (let t = g; t < end; t++) {
            if (chars.slice(jj2, jj2 + consume[t]) === '§') hasSoloIcon = true;
            jj2 += consume[t];
          }
          if (sum === runLen || runLen === 1 || (runLen === 2 && hasSoloIcon)) {
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

if (cmd === 'statocr') {
  const bank = new GlyphBank(JSON.parse(readFileSync(`${ROOT}data/glyphbank.json`, 'utf-8')));
  let pass = 0, fail = 0;
  // 本番と同じ経路: 検出 → crop → segment → recognize → parse
  const check = (name, got) => {
    const gp = `${ROOT}test/golden/${name}.stat.json`;
    const want = JSON.parse(readFileSync(gp, 'utf-8'));
    console.log(`\n== ${name}`);
    let bad = 0;
    for (const [k, v] of Object.entries(want)) {
      if (got.values[k] !== v) { bad++; console.log(` NG ${k}: got=${JSON.stringify(got.values[k])} want=${v}`); }
    }
    for (const k of Object.keys(got.values)) {
      if (!(k in want)) { bad++; console.log(` NG 余分なキー ${k}=${got.values[k]}`); }
    }
    for (const l of got.unknownLines) { bad++; console.log(` NG 未知行 ${JSON.stringify(l)}`); }
    if (bad) fail++; else { pass++; console.log(` ${Object.keys(want).length} 項目すべてOK`); }
  };

  for (const name of ['stat_window', 'stat_window_b']) {
    const { lines } = loadStatSample(name);
    check(name, parseStatWindow(recognizeLines(lines, bank)));
  }
  {
    const name = 'stat_popup_matt';
    const img = decodePNG(`${ROOT}test/fixtures/${name}.png`);
    const bbox = findStatPopup(img);
    if (bbox.error) { fail++; console.log(`\n== ${name}\n NG findStatPopup -> ${bbox.error}`); }
    else check(name, parseStatPopup(recognizeLines(segmentLines(crop(img, bbox)), bank), 'atk'));
  }
  {
    const name = 'level_badge';
    const img = decodePNG(`${ROOT}test/fixtures/${name}.png`);
    const bbox = findLevelBadge(img);
    if (bbox.error) { fail++; console.log(`\n== ${name}\n NG findLevelBadge -> ${bbox.error}`); }
    else check(name, parseLevel(recognizeLines(segmentLines(crop(img, bbox)), bank)));
  }

  console.log(`\nstatocr: pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
}

if (cmd === 'statdetect') {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(` NG ${msg}`); } };
  const eq = (got, want, msg) => ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${msg}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`,
  );
  const load = (name) => decodePNG(`${ROOT}test/fixtures/${name}.png`);

  // フィクスチャは 1922x1232 のフレームから (540,340) を原点に切り出したもの。
  // 期待矩形はテンプレ採取時の実測値で、UI位置が動いてもアンカー追従で同じ大きさになる
  const WIN = { x: 238, y: 191, w: 436, h: 254 };
  for (const name of ['stat_window', 'stat_window_b']) {
    const img = load(name);
    eq(findStatWindow(img), WIN, `${name}: STATウィンドウ矩形`);
    eq(findStatPopup(img), { error: 'not_found' }, `${name}: ポップアップは無い`);
    // 行分割: 上段8行(DAMAGE RANGE〜ADDITIONAL STATUS DAMAGE) + 下段3行
    const lines = segmentLines(crop(img, findStatWindow(img)));
    eq(lines.length, 11, `${name}: 11行に分割される`);
    ok(lines.every((l) => l.glyphs.length >= 20), `${name}: 各行に十分なグリフがある`);
  }

  const pop = load('stat_popup_matt');
  eq(findStatPopup(pop), { x: 426, y: 459, w: 210, h: 64 }, 'ポップアップ [Applied Value] 直後3行ぶんの矩形');
  const popLines = segmentLines(crop(pop, findStatPopup(pop)));
  eq(popLines.length, 2, 'MAGIC ATTのポップアップは2行(3行目が無い。見出し[Base Value]も巻き込まない)');

  const lv = load('level_badge');
  eq(findLevelBadge(lv), { x: 290, y: 41, w: 40, h: 26 }, 'レベルバッジ(CHARACTER INFOタイトル基準)の矩形');
  eq(segmentLines(crop(lv, findLevelBadge(lv))).length, 1, 'レベルは1行');
  eq(findLevelBadge(load('stat_window')), { error: 'not_found' },
    'CHARACTER INFOが写っていなければ not_found(取り込みは止めない)');

  // 誤検出しないこと: 装備ツールチップのサンプルにはどちらのアンカーも無い
  const tip = decodePNG(`${ROOT}samples/berserked.png`);
  eq(findStatWindow(tip), { error: 'not_found' }, '装備ツールチップをSTATウィンドウと誤検出しない');
  eq(findStatPopup(tip), { error: 'not_found' }, '装備ツールチップをポップアップと誤検出しない');
  eq(findLevelBadge(tip), { error: 'not_found' }, '装備ツールチップをレベルバッジと誤検出しない');

  console.log(`\nstatdetect: pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
}

if (cmd === 'parsestat') {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => { if (cond) { pass++; } else { fail++; console.log(` NG ${msg}`); } };
  const eq = (got, want, msg) => ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${msg}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`,
  );
  const vals = (lines) => parseStatWindow(lines).values;

  // --- ラベル表とフォーム定義の整合(ここがズレると取り込んでもフォームに入らない) ---
  const fieldKeys = new Set(SCOUTER_FIELDS.map((f) => f.key));
  for (const { key } of STAT_LABELS) ok(fieldKeys.has(key), `STAT_LABELS の ${key} が SCOUTER_FIELDS に無い`);
  for (const k of ['coolTimeReduce', 'coolTimeReducePercent']) ok(fieldKeys.has(k), `${k} が SCOUTER_FIELDS に無い`);

  // --- 数値抽出 ---
  eq(numbersIn('1,320').map((x) => x.value), [1320], 'カンマ区切り');
  eq(numbersIn('85.5%').map((x) => [x.value, x.pct]), [[85.5, true]], '小数と%フラグ');
  eq(numbersIn('ARCANE POWER').length, 0, '数値なし行');

  // --- 実画面の行(test/fixtures/stat_window.png の見たまま) ---
  // 2カラムなので1行に「左ラベル 左値 右ラベル 右値」が並ぶ
  eq(vals(['DAMAGE RANGE 126,517,810 DAMAGE 71.00%']), { dmg: 71 },
    '左のDAMAGE RANGEは無視し、右のDAMAGEだけ拾う(食い合い防止)');
  eq(vals(['FINAL DAMAGE 169.92% BOSS DAMAGE 482.00%']), { bossDmg: 482 },
    'FINAL DAMAGEは対象外、BOSS DAMAGEのみ');
  eq(vals(['IGNORE DEFENSE 96.85% NORMAL ENEMY DAMAGE 12.00%']),
    { ignoreDef: 96.85, normalDmg: 12 }, '1行から2キー(小数も保持)');
  eq(vals(['ATTACK POWER 7,081 CRITICAL RATE 90%']), { critical: 90 },
    'ATTACK POWERの値が CRITICAL RATE に流れ込まない');
  eq(vals(['MAGIC ATT 2,673 CRITICAL DAMAGE 113.65%']), { criticalDmg: 113.65 }, 'MAGIC ATTは対象外');
  eq(vals(['COOLDOWN REDUCTION 4 sec / 5% BUFF DURATION 30%']),
    { coolTimeReduce: 4, coolTimeReducePercent: 5, buffDuration: 30 },
    'sec と % を分解しつつ、右のBUFF DURATIONも取る');
  eq(vals(['COOLDOWN NOT APPLIED 7.50% IGNORE ELEMENTAL RESISTANCE 5.00%']),
    { resetCoolDown: 7.5, ignoreElementalResist: 5 }, 'クールタイム未適用=リセット率');
  eq(vals(['ADDITIONAL STATUS DAMAGE 23.00% SUMMONS DURATION INCREASE 10%']),
    { statusAdditionalDmg: 23, summonPersistTime: 10 }, '状態異常追加ダメージ/召喚獣持続');
  eq(vals(['ITEM DROP RATE 22% ARCANE POWER 1,360']), { arcaneForce: 1360 }, 'アーケインフォース');
  eq(vals(['ADDITIONAL EXP OBTAINED 222.00% SACRED POWER 760']), { authenticForce: 760 },
    'オーセンティックフォース(GMS表記はSACRED POWER)');
  eq(vals(['MESOS OBTAINED 656% STAR FORCE 412']), {}, '対象外だけの行は何も取らない');

  // --- OCRの癖 ---
  eq(vals(['lGNORE DEFENSE 96.85% NORMAL ENEMY DAMAGE 12.00%']),
    { ignoreDef: 96.85, normalDmg: 12 }, 'OCRのI/l揺れを吸収');
  eq(vals(['CRITICALDAMAGE 113.65%']), { criticalDmg: 113.65 }, '語間スペースが落ちても拾う');

  // --- 未取得・未知行の扱い ---
  eq(vals(['BOSS DAMAGE']), {}, '値が無いラベル行はキーを作らない(フォームは空欄のまま)');
  const mixed = parseStatWindow(['DAMAGE RANGE 1 DAMAGE 55%', 'HONOR EXP 12,345', '']);
  eq(mixed.values, { dmg: 55 }, '未知行があっても既知だけ取る');
  eq(mixed.unknownLines, ['HONOR EXP 12,345'], '未知行を返す(空行は含めない)');

  // --- recognizeLines形式({text}) でも通る ---
  eq(vals([{ text: 'BOSS DAMAGE 482.00%' }]), { bossDmg: 482 }, '{text}オブジェクト形式');

  // --- 一括: フィクスチャの11行をそのまま ---
  eq(vals([
    'DAMAGE RANGE 126,517,810 DAMAGE 71.00%',
    'FINAL DAMAGE 169.92% BOSS DAMAGE 482.00%',
    'IGNORE DEFENSE 96.85% NORMAL ENEMY DAMAGE 12.00%',
    'ATTACK POWER 7,081 CRITICAL RATE 90%',
    'MAGIC ATT 2,673 CRITICAL DAMAGE 113.65%',
    'COOLDOWN REDUCTION 4 sec / 5% BUFF DURATION 30%',
    'COOLDOWN NOT APPLIED 7.50% IGNORE ELEMENTAL RESISTANCE 5.00%',
    'ADDITIONAL STATUS DAMAGE 23.00% SUMMONS DURATION INCREASE 10%',
    'MESOS OBTAINED 656% STAR FORCE 412',
    'ITEM DROP RATE 22% ARCANE POWER 1,360',
    'ADDITIONAL EXP OBTAINED 222.00% SACRED POWER 760',
  ]), {
    dmg: 71, bossDmg: 482, ignoreDef: 96.85, normalDmg: 12, critical: 90, criticalDmg: 113.65,
    coolTimeReduce: 4, coolTimeReducePercent: 5, buffDuration: 30,
    resetCoolDown: 7.5, ignoreElementalResist: 5,
    statusAdditionalDmg: 23, summonPersistTime: 10, arcaneForce: 1360, authenticForce: 760,
  }, 'STATウィンドウ全11行 → 15キー');

  // --- レベルバッジ ---
  eq(parseLevel(['292']).values, { level: 292 }, 'レベル');
  eq(parseLevel([{ text: '1' }]).values, { level: 1 }, '1桁');
  eq(parseLevel(['301']).values, {}, '301以上は誤読とみなして捨てる');
  eq(parseLevel(['0']).values, {}, '0は捨てる');
  eq(parseLevel(['29.2']).values, {}, '小数は捨てる');
  eq(parseLevel(['']).values, {}, '空でも落ちない');

  // --- ポップアップ([Applied Value] の2行。test/fixtures/stat_popup_matt.png の見たまま) ---
  eq(parseStatPopup(['Base Value : 2546', '% Value : 5%'], 'atk').values,
    { atkBase: 2546, atkPercent: 5 }, '攻撃力: Base Value と % Value(3行目が無いケース)');
  // 実画面(STRのポップアップ): 3行目の「% Value Not Applied」が固定加算
  eq(parseStatPopup(['Base Value : 6604', '% Value : 518%', '% Value Not Applied : 30700'], 'mainStat').values,
    { mainStatBase: 6604, mainStatPer: 518, mainStatAbs: 30700 },
    'メインステ: 素/増加率/固定加算の3値');
  eq(parseStatPopup(['Base Value : 6604', '% Value Not Applied : 30700', '% Value : 518%'], 'mainStat').values,
    { mainStatBase: 6604, mainStatAbs: 30700, mainStatPer: 518 },
    '行順が入れ替わっても増加率が固定加算で上書きされない');
  eq(parseStatPopup(['Base Value : 999', '% Value : 0%'], 'subStat').values,
    { subStatBase: 999, subStatPer: 0 }, 'サブステ(0%でもキーを作る)');
  eq(parseStatPopup(['Base Value : 2546'], 'atk').values, { atkBase: 2546 }, '%行が無くても落ちない');
  eq(parseStatPopup(['Base Value : 2546', '% Value : 5%'], 'unknown').values, {}, '対象不明なら何も返さない');
  eq(parseStatPopup(['[Base Value]', 'なにか'], 'atk').unknownLines, [], '値の無い行(見出し・文字だけ)は無視する');
  // ラベルが未知グリフで潰れても、行順(素→増加率→固定加算)から復元できる
  eq(parseStatPopup(['B?se V?lue : 6604', '% V?lue : 518%', '% V?lue N?t A??lied : 30700'], 'mainStat').values,
    { mainStatBase: 6604, mainStatPer: 518, mainStatAbs: 30700 },
    'OCRが一部潰れても位置で復元(%行の取り違えも起きない)');
  eq(parseStatPopup(['???? : 6604', '???? : 518%', '???? : 30700'], 'subStat').values,
    { subStatBase: 6604, subStatPer: 518, subStatAbs: 30700 },
    'ラベルが全滅しても行順で割り当てる');

  console.log(`\nparsestat: pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
}

if (cmd === 'scouter') {
  let pass = 0, fail = 0;
  const ok = (cond, msg) => {
    if (cond) { pass++; } else { fail++; console.log(` NG ${msg}`); }
  };
  const eq = (got, want, msg) => ok(
    JSON.stringify(got) === JSON.stringify(want),
    `${msg}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`,
  );

  // --- buildDiff: 空欄除外 / カンマ・%・全角・単位の除去 / 数値化不能の除外 ---
  eq(buildDiff({
    level: '275',
    dmg: '',
    bossDmg: '1,234',
    critical: '12%',
    criticalDmg: '  8.5 ',
    ignoreDef: 'abc',
    coolTimeReduce: '2秒',
    arcaneForce: '１２３',
    normalDmg: '0',
    myClass: 'アークメイジ', // フィールド定義外のキーは無視
  }), {
    // キー順は SCOUTER_FIELDS の定義順
    level: 275, bossDmg: 1234, normalDmg: 0, critical: 12, criticalDmg: 8.5,
    coolTimeReduce: 2, arcaneForce: 123,
  }, 'buildDiff の数値変換');
  ok(!('dmg' in buildDiff({ dmg: '' })), 'buildDiff: 空欄はキーごと除外');
  ok(!('dmg' in buildDiff({ dmg: '   ' })), 'buildDiff: 空白のみはキーごと除外');
  ok(!('dmg' in buildDiff({ dmg: 'abc' })), 'buildDiff: 数値化不能はキーごと除外');
  ok(!('myClass' in buildDiff({ myClass: 'x' })), 'buildDiff: 未定義キーは持ち込まない');
  eq(buildDiff({}), {}, 'buildDiff: 全欄空なら空オブジェクト');
  eq(buildDiff({ dmg: '-5' }), { dmg: -5 }, 'buildDiff: 負値');

  // --- applyDiff: マージ・非対象キー据え置き・構造欠損 ---
  const freshRoot = () => JSON.parse(JSON.stringify({
    state: { preset: { 1: { data: { stat: { myClass: 'アークメイジ', dmg: 1, level: 200 } } } } },
    version: 0,
  }));
  const r1 = freshRoot();
  const res1 = applyDiff(r1, '1', { dmg: 55, bossDmg: 300 });
  ok(!res1.error, 'applyDiff: 正常系はerrorなし');
  eq(r1.state.preset['1'].data.stat,
    { myClass: 'アークメイジ', dmg: 55, level: 200, bossDmg: 300 },
    'applyDiff: 差分マージ + 非対象キー据え置き');
  eq(applyDiff(freshRoot(), 1, { dmg: 9 }).error, undefined, 'applyDiff: スロットは数値でも可');
  eq(applyDiff(freshRoot(), '2', { dmg: 9 }).error, 'no-slot', 'applyDiff: スロット欠損');
  eq(applyDiff({ state: {} }, '1', {}).error, 'no-preset', 'applyDiff: preset欠損');
  eq(applyDiff({ state: { preset: { 1: {} } } }, '1', {}).error, 'no-stat', 'applyDiff: stat欠損');

  // --- 生成コードをそのまま実行(出荷物の実挙動テスト) ---
  function runBookmarklet(href, { hostname = 'maplescouter.com', stored } = {}) {
    ok(href.startsWith('javascript:'), 'buildBookmarklet: javascript: スキーム');
    const code = decodeURIComponent(href.slice('javascript:'.length));
    const mem = new Map();
    if (stored !== undefined) mem.set(PRESET_KEY, stored);
    const alerts = [];
    let reloaded = false;
    const ls = {
      getItem: (k) => (mem.has(k) ? mem.get(k) : null),
      setItem: (k, v) => mem.set(k, String(v)),
    };
    const loc = { hostname, reload: () => { reloaded = true; } };
    new Function('localStorage', 'location', 'alert', code)(ls, loc, (m) => alerts.push(String(m)));
    return { alerts, reloaded, saved: mem.get(PRESET_KEY) };
  }

  const storedOk = JSON.stringify(freshRoot());
  const href = buildBookmarklet({ dmg: 55, bossDmg: 300 }, '1');

  const okRun = runBookmarklet(href, { stored: storedOk });
  eq(okRun.alerts, [], '正常系: alertなし');
  ok(okRun.reloaded, '正常系: location.reload() が呼ばれる');
  eq(JSON.parse(okRun.saved), {
    state: { preset: { 1: { data: { stat: { myClass: 'アークメイジ', dmg: 55, level: 200, bossDmg: 300 } } } } },
    version: 0,
  }, '正常系: 差分マージ結果が書き戻される(version等も保持)');

  const wwwRun = runBookmarklet(href, { hostname: 'www.maplescouter.com', stored: storedOk });
  ok(wwwRun.reloaded && !wwwRun.alerts.length, 'www サブドメインでも動く');

  const badHost = runBookmarklet(href, { hostname: 'evil-maplescouter.com.example.jp', stored: storedOk });
  ok(badHost.alerts.length === 1 && !badHost.reloaded, 'ホスト不一致: alertして中断');
  eq(badHost.saved, storedOk, 'ホスト不一致: 書き込みなし');

  const noKey = runBookmarklet(href, {});
  ok(noKey.alerts.length === 1 && !noKey.reloaded, 'キー不在: alertして中断');
  ok(/先にmaplescouter/.test(noKey.alerts[0] || ''), 'キー不在: 先に入力を促す文言');
  ok(noKey.saved === undefined, 'キー不在: 新規作成しない');

  const broken = runBookmarklet(href, { stored: '{"state":' });
  ok(broken.alerts.length === 1 && !broken.reloaded, '壊れJSON: alertして中断');
  eq(broken.saved, '{"state":', '壊れJSON: 元データを壊さない');

  const noSlot = runBookmarklet(buildBookmarklet({ dmg: 1 }, '3'), { stored: storedOk });
  ok(noSlot.alerts.length === 1 && !noSlot.reloaded, 'スロット不在: alertして中断');
  ok(/プリセット3/.test(noSlot.alerts[0] || ''), 'スロット不在: 対象スロット番号を出す');
  eq(noSlot.saved, storedOk, 'スロット不在: 書き込みなし');

  // 文字列値のエスケープ(将来diffに文字列が入っても壊れない)
  const esc = runBookmarklet(buildBookmarklet({ dmg: 1, note: `a'b"c\\d</script>` }, '1'), { stored: storedOk });
  eq(JSON.parse(esc.saved).state.preset['1'].data.stat.note, `a'b"c\\d</script>`, '埋め込み値のエスケープ');

  console.log(`\nscouter: pass=${pass} fail=${fail}`);
  process.exitCode = fail ? 1 : 0;
}

if (cmd === 'ocr' || cmd === 'parse') {
  const bank = new GlyphBank(JSON.parse(readFileSync(`${ROOT}data/glyphbank.json`, 'utf-8')));
  let pass = 0, fail = 0;
  for (const name of SAMPLES) {
    const { lines, linesAll, stars } = loadSample(name);
    // ocr(golden行比較)は星列抜き、parse(星数含む)は全行で本番と同じ経路
    const rec = recognizeLines(cmd === 'parse' ? linesAll : lines, bank);
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
