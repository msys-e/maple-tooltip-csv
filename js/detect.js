// ツールチップ矩形検出 + スターフォース星カウント
//
// フルスクリーンフレームでは背景色ベースの検出は成立しない(夜マップの暗色や
// 隣接パネルと融合する)ため、固定フォント描画の "Required Job" 白画素パターンを
// アンカーにし、そこから上下の縁(直近内部より一様に明るい1pxライン)を走査して
// 矩形を確定する。ツールチップ単体のスクショ(小さい画像)は従来のブロブ方式。
import { connectedComponents } from './imgproc.js';

export const TOOLTIP_MIN_W = 295;
export const TOOLTIP_MAX_W = 365;
export const TOOLTIP_MIN_H = 180;

// ---- アンカーテンプレ: berserkedサンプル "Required Job" 行の白画素 (等倍) ----
const ANCHOR_W = 80, ANCHOR_H = 13;
const ANCHOR_INK = [81,161,241,321,401,481,561,641,721,82,402,83,403,84,404,85,405,485,86,406,566,646,167,247,327,727,330,410,490,570,650,251,491,731,252,492,732,253,493,733,334,414,494,654,337,417,497,577,657,258,738,259,739,340,660,261,341,421,501,581,661,741,821,901,264,344,424,504,584,664,745,746,747,268,348,428,508,588,668,748,111,271,351,431,511,591,671,751,274,354,434,514,594,674,754,355,276,358,438,518,598,678,279,519,759,280,520,760,281,521,761,362,442,522,682,365,445,525,605,685,286,766,287,767,368,768,129,209,289,369,449,529,609,689,769,614,694,775,776,777,138,218,298,378,458,538,618,698,381,461,541,621,701,302,782,303,783,304,784,385,465,545,625,705,148,228,308,388,468,548,628,708,788,389,709,310,790,311,791,392,472,552,632,712];
const ANCHOR_HOLES = [80,160,322,482,560,722,2,483,4,165,486,166,326,726,248,728,329,409,569,649,332,412,254,573,813,415,655,257,498,576,656,260,740,420,181,502,662,820,900,184,425,503,665,825,827,267,347,509,587,828,110,270,432,510,672,831,273,435,513,675];
const ANCHOR_OFF_X = 16; // テンプレ原点はツールチップ左端から16px

function isWhitePx(d, p) {
  const r = d[p], g = d[p + 1], b = d[p + 2];
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  return mn > 140 && mx - mn < 60 && mx >= 150;
}

function findAnchor(img) {
  const { width: w, height: h, data: d } = img;
  const mask = new Uint8Array(w * h);
  for (let i = 0, p = 0; i < w * h; i++, p += 4) mask[i] = isWhitePx(d, p) ? 1 : 0;
  const probes = [ANCHOR_INK[0], ANCHOR_INK[60], ANCHOR_INK[120], ANCHOR_INK[180]];
  for (let y = 0; y <= h - ANCHOR_H; y++) {
    for (let x = 0; x <= w - ANCHOR_W; x++) {
      const o = y * w + x;
      let quick = true;
      for (const t of probes) {
        if (!mask[o + ((t / ANCHOR_W) | 0) * w + (t % ANCHOR_W)]) { quick = false; break; }
      }
      if (!quick) continue;
      let ink = 0;
      for (const t of ANCHOR_INK) {
        if (mask[o + ((t / ANCHOR_W) | 0) * w + (t % ANCHOR_W)]) ink++;
      }
      if (ink < ANCHOR_INK.length * 0.96) continue;
      let holes = 0;
      for (const t of ANCHOR_HOLES) {
        if (!mask[o + ((t / ANCHOR_W) | 0) * w + (t % ANCHOR_W)]) holes++;
      }
      if (holes >= ANCHOR_HOLES.length * 0.8) return { x, y };
    }
  }
  return null;
}

// 行輝度ユーティリティ
function lumAt(d, p) {
  return d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
}

function boxFromAnchor(img, a) {
  const { width: w, height: h, data: d } = img;
  const bx = a.x - ANCHOR_OFF_X;
  if (bx < 0 || bx + TOOLTIP_MIN_W > w) return { error: 'clipped' }; // 左右に見切れている
  const x0 = Math.max(0, bx + 8), x1 = Math.min(w - 1, bx + 308);
  const n = x1 - x0 + 1;
  const rowLum = (y) => {
    const out = new Float64Array(n);
    let p = (y * w + x0) * 4;
    for (let i = 0; i < n; i++, p += 4) out[i] = lumAt(d, p);
    return out;
  };
  // 縁テスト: 2px離れた基準行より一様に明るい
  const edgeFrac = (y, refY) => {
    if (y < 0 || refY < 0 || y >= h || refY >= h) return 0;
    const cur = rowLum(y), ref = rowLum(refY);
    let c = 0;
    for (let i = 0; i < n; i++) if (cur[i] >= ref[i] + 10) c++;
    return c / n;
  };

  // 上縁: 最初の縁候補は「名前ブロックとアイコンブロックの間の区切り線」(D1)。
  // 真の上端は 星クラスタ(不透明アイコンで色が確実) か 名前ブロック上端 から決め、
  // その直上の縁候補を採用する。
  const upCands = [];
  for (let y = a.y - 4; y >= Math.max(0, a.y - 560); y--) {
    if (edgeFrac(y, y + 2) >= 0.85) upCands.push(y);
  }
  const d1 = upCands[0] ?? Math.max(0, a.y - 60);
  // 名前ブロック上端(NT): 中央1/3に強い白(名前)か強いオレンジ(Untradable)がある行を
  // d1 から上へ gap≤8 で辿る。背景の淡いハイライトを拾わないよう閾値は強め。
  const mx0 = Math.min(w - 2, bx + 108), mx1 = Math.min(w - 1, bx + 218);
  const nameRow = (y) => {
    let c = 0;
    let p = (y * w + mx0) * 4;
    for (let x = mx0; x <= mx1; x++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      const mn = Math.min(r, g, b);
      if ((mn > 170 && Math.max(r, g, b) - mn < 50) || (r > 210 && g >= 95 && g < 175 && b < 80)) c++;
    }
    return c >= 5;
  };
  let NT = -1, gap = 0;
  for (let y = d1 - 3; y >= Math.max(0, d1 - 70); y--) {
    if (nameRow(y)) { NT = y; gap = 0; }
    else if (NT >= 0 && ++gap > 8) break;
  }
  let contentTop = NT >= 0 ? NT : d1 - 2;
  if (NT >= 0) {
    // 星は名前ブロック直上の狭い窓だけで探す(インベントリの金色アイコン対策)
    for (let y = NT - 4; y >= Math.max(0, NT - 46); y--) {
      let rowStar = 0;
      let p = (y * w + x0) * 4;
      for (let i = 0; i < n; i++, p += 4) {
        const r = d[p], g = d[p + 1], b = d[p + 2];
        if (r > 200 && g > 150 && g < 220 && b < 70 && r > g) rowStar++;
      }
      if (rowStar >= 4) contentTop = y;
    }
  }
  const above = upCands.filter((y) => y <= contentTop - 2 && y >= contentTop - 16);
  const top = above.length ? Math.max(...above) : Math.max(0, contentTop - 8);

  // 内部輝度の推定(低分散の暗い行の中央値)
  const interiorSamples = [];
  for (let y = a.y + 16; y < Math.min(h, a.y + 200); y++) {
    const cur = rowLum(y);
    let m = 0;
    for (const v of cur) m += v;
    m /= n;
    if (m > 130) continue;
    let uni = 0;
    for (const v of cur) if (Math.abs(v - m) < 6) uni++;
    if (uni / n >= 0.95) interiorSamples.push(m);
  }
  interiorSamples.sort((p, q) => p - q);
  const interior = interiorSamples[interiorSamples.length >> 1] ?? 50;

  const interiorish = (y) => {
    if (y >= h) return 0;
    const cur = rowLum(y);
    let c = 0;
    for (const v of cur) if (Math.abs(v - interior) < 10) c++;
    return c / n;
  };

  // 下縁: 縁候補のうち「直後に内部色の行が続かない」最初のもの
  //  (区切り線は直後が内部/テキスト行なので除外される)
  let bottom = -1, lastCand = -1;
  for (let y = a.y + 18; y < Math.min(h - 3, a.y + 760); y++) {
    if (edgeFrac(y, y - 2) < 0.85) continue;
    lastCand = y;
    let hasInterior = false;
    for (let yy = y + 3; yy <= Math.min(h - 1, y + 12); yy++) {
      if (interiorish(yy) >= 0.55) { hasInterior = true; break; }
    }
    if (!hasInterior) { bottom = y; break; }
  }
  if (bottom < 0) bottom = lastCand > 0 ? lastCand : Math.min(h - 1, a.y + 400);

  // 幅: 下縁の縁色ラン(直上より明るい)を右へ伸ばして右端を得る。左端はアンカー由来のbx
  let right = x1;
  {
    let x = x1;
    while (x < Math.min(w - 1, bx + TOOLTIP_MAX_W + 10)) {
      const nl = lumAt(d, ((bottom * w) + x + 1) * 4);
      const rl = lumAt(d, (((bottom - 2) * w) + x + 1) * 4);
      if (nl < rl + 6) break;
      x++;
    }
    right = x;
  }
  const bbox = { x: Math.max(0, bx), y: Math.max(0, top - 1), w: right - bx + 3, h: bottom - top + 4 };
  if (bbox.x + bbox.w > w) bbox.w = w - bbox.x;
  if (bbox.y + bbox.h > h) bbox.h = h - bbox.y;
  if (bbox.w < TOOLTIP_MIN_W || bbox.w > TOOLTIP_MAX_W) return { error: 'bad_width', bbox };
  if (bbox.h < TOOLTIP_MIN_H) return { error: 'clipped', bbox };
  return bbox;
}

// ---- 従来のブロブ方式(ツールチップ単体スクショ用) ----
function isTooltipBg(r, g, b) {
  return r < 100 && g < 100 && b < 130 && b >= r - 10 && Math.max(r, g, b) < 110;
}

function findTooltipBlob(img) {
  const S = 4;
  const sw = Math.floor(img.width / S), sh = Math.floor(img.height / S);
  const mask = new Uint8Array(sw * sh);
  const d = img.data;
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      const p = (y * S * img.width + x * S) * 4;
      if (isTooltipBg(d[p], d[p + 1], d[p + 2])) mask[y * sw + x] = 1;
    }
  }
  const comps = connectedComponents(mask, sw, sh, false);
  let best = null;
  for (const c of comps) {
    const w = (c.x1 - c.x0 + 1) * S, h = (c.y1 - c.y0 + 1) * S;
    if (w < TOOLTIP_MIN_W - 40 || h < TOOLTIP_MIN_H) continue;
    const fill = c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
    if (fill < 0.55) continue;
    if (!best || c.area > best.area) best = c;
  }
  if (!best) return { error: 'not_found' };
  const bbox = {
    x: best.x0 * S, y: best.y0 * S,
    w: (best.x1 - best.x0 + 1) * S, h: (best.y1 - best.y0 + 1) * S,
  };
  // 画像端に接触 = 欠けの可能性。ただし画像自体がツールチップのcropなら許容
  if (bbox.x <= 1 || bbox.y <= 1 || bbox.x + bbox.w >= img.width - 2 || bbox.y + bbox.h >= img.height - 2) {
    if (!(bbox.w >= img.width - 8 && bbox.h >= img.height - 8)) return { error: 'clipped', bbox };
  }
  if (bbox.w < TOOLTIP_MIN_W || bbox.w > TOOLTIP_MAX_W) return { error: 'bad_width', bbox };
  return bbox;
}

export function findTooltip(img) {
  // フルスクリーン級のフレームはアンカー方式、小さい画像(ツールチップ単体crop)はブロブ方式
  if (img.width < 600) return findTooltipBlob(img);
  const a = findAnchor(img);
  if (!a) return { error: 'not_found' };
  return boxFromAnchor(img, a);
}

// スターフォース星カウント: bbox 上部帯の黄色星ブロブを数える
export function countStars(img, bbox) {
  const band = Math.min(48, bbox.h);
  const w = bbox.w;
  const mask = new Uint8Array(w * band);
  const d = img.data;
  for (let y = 0; y < band; y++) {
    let p = ((bbox.y + y) * img.width + bbox.x) * 4;
    for (let x = 0; x < w; x++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2];
      if (r > 170 && g > 130 && b < 100 && r >= g) mask[y * w + x] = 1;
    }
  }
  const comps = connectedComponents(mask, w, band, false);
  const blobs = [];
  for (const c of comps) {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if (c.area >= 12 && cw >= 5 && cw <= 18 && ch >= 5 && ch <= 18) blobs.push((c.y0 + c.y1) / 2);
  }
  // 星は横一列に並ぶ: y整列(±3px)で2個以上のクラスタだけ数える(背景の金色ブロブ対策)
  blobs.sort((p, q) => p - q);
  let n = 0;
  for (let i = 0; i < blobs.length; ) {
    let j = i;
    while (j < blobs.length && blobs[j] - blobs[i] <= 3) j++;
    if (j - i >= 2) n += j - i;
    i = j;
  }
  // ★1装備の救済: ブロブがちょうど1個だけなら本物の星とみなす(散在ノイズなら複数出る)
  if (n === 0 && blobs.length === 1) n = 1;
  return n;
}
