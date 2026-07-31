// 行分割・グリフ分割
import { C, COLOR_NAMES, classifyPixels, connectedComponents, componentBitmap, bitmapKey } from './imgproc.js';

const STAR_BAND = 44;      // bbox 上部の星帯(行処理から除外)
const MAX_TEXT_H = 20;     // これより高い成分は文字でない
const MAX_TEXT_W = 34;     // これより広い成分は文字でない(合字含む)
const ICON_MIN = 55;       // これ以上の大きさの成分はアイコン枠とみなし排他ゾーン化

// ツールチップ crop 済み画像(または bbox)から行とグリフを切り出す
// 戻り値: [{y0,y1,x0,x1,bullet,glyphs:[{x0,x1,y0,y1,color,key,bitmap}]}]
export function segmentLines(img, bbox) {
  const cls = classifyPixels(img, bbox);
  const { map, w, h } = cls;
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < w * h; i++) mask[i] = map[i] ? 1 : 0;
  const comps = connectedComponents(mask, w, h, true);

  // アイコン枠(大成分)を排他ゾーンに
  const zones = [];
  for (const c of comps) {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if (cw >= ICON_MIN && ch >= ICON_MIN) {
      zones.push({ x0: c.x0 - 4, y0: c.y0 - 4, x1: c.x1 + 4, y1: c.y1 + 4 });
    }
  }
  const inZone = (c) => {
    const cx = (c.x0 + c.x1) / 2, cy = (c.y0 + c.y1) / 2;
    return zones.some((z) => cx >= z.x0 && cx <= z.x1 && cy >= z.y0 && cy <= z.y1);
  };

  // 文字らしい成分だけ残す(境界4pxはツールチップ枠外の背景漏れなので除外)
  const INSET = 4;
  const textComps = comps.filter((c) => {
    const cw = c.x1 - c.x0 + 1, ch = c.y1 - c.y0 + 1;
    if ((c.y0 + c.y1) / 2 < STAR_BAND) return false;
    if (c.x0 < INSET || c.y0 < INSET || c.x1 >= w - INSET || c.y1 >= h - INSET) return false;
    if (c.x0 >= w - 12 && cw <= 4) return false; // 右端スクロールバー
    if (ch > MAX_TEXT_H || cw > MAX_TEXT_W) return false;
    return !inZone(c); // 1px成分も残す(':'は1pxドット2個)
  });

  // 行クラスタリング: y範囲の重なりでグルーピング
  textComps.sort((a, b) => a.y0 - b.y0 || a.x0 - b.x0);
  const lines = [];
  for (const c of textComps) {
    let target = null;
    for (const ln of lines) {
      const ov = Math.min(ln.y1, c.y1) - Math.max(ln.y0, c.y0) + 1;
      const ch = c.y1 - c.y0 + 1;
      const minH = Math.min(ln.y1 - ln.y0 + 1, ch);
      // 小成分(カンマ等)はベースライン下にはみ出しても行に帰属させる
      const tinyDescender = ch <= 4 && c.y0 >= ln.y0 && c.y0 <= ln.y1 + 1;
      if ((ov >= minH * 0.5 && ov > 0) || tinyDescender) { target = ln; break; }
    }
    if (target) {
      target.comps.push(c);
      target.y0 = Math.min(target.y0, c.y0);
      target.y1 = Math.max(target.y1, c.y1);
    } else {
      lines.push({ y0: c.y0, y1: c.y1, comps: [c] });
    }
  }
  lines.sort((a, b) => a.y0 - b.y0);

  // 行内: x重なり結合(iの点, %, : 等) → グリフ化
  for (const ln of lines) {
    ln.comps.sort((a, b) => a.x0 - b.x0);
    const groups = [];
    for (const c of ln.comps) {
      const last = groups[groups.length - 1];
      if (last) {
        const ov = Math.min(last.x1, c.x1) - Math.max(last.x0, c.x0) + 1;
        const minW = Math.min(last.x1 - last.x0, c.x1 - c.x0) + 1;
        if (ov > 0 && ov >= minW * 0.6) {
          last.members.push(c);
          last.x0 = Math.min(last.x0, c.x0);
          last.x1 = Math.max(last.x1, c.x1);
          last.y0 = Math.min(last.y0, c.y0);
          last.y1 = Math.max(last.y1, c.y1);
          continue;
        }
      }
      groups.push({ x0: c.x0, x1: c.x1, y0: c.y0, y1: c.y1, members: [c] });
    }

    const lineMid = (ln.y0 + ln.y1) / 2;
    ln.glyphs = groups.map((g) => {
      // グループ合成ビットマップ
      const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
      const bits = new Uint8Array(gw * gh);
      const colorCount = new Array(COLOR_NAMES.length).fill(0);
      for (const m of g.members) {
        for (const p of m.pixels) {
          const px = p % w, py = (p / w) | 0;
          bits[(py - g.y0) * gw + (px - g.x0)] = 1;
          colorCount[map[p]]++;
        }
      }
      let color = C.WHITE, mx = 0;
      for (let i = 1; i < colorCount.length; i++) {
        if (colorCount[i] > mx) { mx = colorCount[i]; color = i; }
      }
      const bm = { w: gw, h: gh, bits };
      let key = bitmapKey(bm);
      // 小型グリフ(. , ' - 等)は行内の上下位置で弁別
      if (gh <= 5) key += ((g.y0 + g.y1) / 2 < lineMid) ? ':T' : ':B';
      return { x0: g.x0, x1: g.x1, y0: g.y0, y1: g.y1, color: COLOR_NAMES[color], key, bitmap: bm };
    });

    ln.x0 = Math.min(...ln.comps.map((c) => c.x0));
    ln.x1 = Math.max(...ln.comps.map((c) => c.x1));

    // 行頭ブレット(ポテンシャル等級): 左端の小さいベタ四角
    ln.bullet = null;
    const first = ln.glyphs[0];
    if (first && first.x0 <= 26) {
      const gw = first.x1 - first.x0 + 1, gh = first.y1 - first.y0 + 1;
      let area = 0;
      for (const b of first.bitmap.bits) area += b;
      const fill = area / (gw * gh);
      if (gw >= 4 && gw <= 9 && gh >= 4 && gh <= 9 && fill > 0.82 && first.color !== 'white') {
        ln.bullet = first.color;
        ln.glyphs.shift();
      }
    }
    delete ln.comps;
  }
  // 微小な単発グリフだけの行はノイズ
  return lines.filter((ln) => {
    if (!ln.glyphs.length) return false;
    if (ln.glyphs.length === 1) {
      const g = ln.glyphs[0];
      let area = 0;
      for (const b of g.bitmap.bits) area += b;
      if (area < 12) return false;
    }
    return true;
  });
}
