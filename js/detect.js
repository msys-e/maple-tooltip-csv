// ツールチップ矩形検出 + スターフォース星カウント
import { connectedComponents } from './imgproc.js';

export const TOOLTIP_MIN_W = 295;
export const TOOLTIP_MAX_W = 365;
export const TOOLTIP_MIN_H = 180;

// ツールチップ背景(暗紺 ~RGB(48,48,64)、半透明合成で多少ブレる)
function isTooltipBg(r, g, b) {
  return r < 100 && g < 100 && b < 130 && b >= r - 10 && Math.max(r, g, b) < 110;
}

// フレーム全体からツールチップ矩形を探す。1/4縮小で背景マスク→連結成分→サイズ検証。
// 戻り値: {x,y,w,h} | {error: 'not_found'|'clipped'|'bad_width', bbox?}
export function findTooltip(img) {
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
    // 塗り率: ツールチップはほぼベタ
    const fill = c.area / ((c.x1 - c.x0 + 1) * (c.y1 - c.y0 + 1));
    if (fill < 0.55) continue;
    if (!best || c.area > best.area) best = c;
  }
  if (!best) return { error: 'not_found' };
  // 原寸で bbox を微調整(縮小誤差 ±S)
  let bx = best.x0 * S, by = best.y0 * S;
  let bw = (best.x1 - best.x0 + 1) * S, bh = (best.y1 - best.y0 + 1) * S;
  const bbox = { x: bx, y: by, w: bw, h: bh };
  if (bx <= 1 || by <= 1 || bx + bw >= img.width - 2 || by + bh >= img.height - 2) {
    // 画面端に接触 = 欠けの可能性。ただしフレーム自体がツールチップのcrop(サンプル画像)なら許容
    if (!(bw >= img.width - 8 && bh >= img.height - 8)) return { error: 'clipped', bbox };
  }
  if (bw < TOOLTIP_MIN_W || bw > TOOLTIP_MAX_W) return { error: 'bad_width', bbox };
  return bbox;
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
  let n = 0;
  for (const c of comps) {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if (c.area >= 12 && cw >= 5 && cw <= 18 && ch >= 5 && ch <= 18) n++;
  }
  return n;
}
