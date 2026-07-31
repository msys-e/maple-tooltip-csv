// 行分割・グリフ分割
import { C, COLOR_NAMES, classifyPixels, classifyMeanColor, connectedComponents, componentBitmap, bitmapKey } from './imgproc.js';

const STAR_BAND = 0;       // 星は形状ベースのisStars判定で除外するため固定帯は廃止
const MAX_TEXT_H = 20;     // これより高い成分は文字でない
const MAX_TEXT_W = 34;     // これより広い成分は文字でない(合字含む)
const ICON_MIN = 55;       // これ以上の大きさの成分はアイコン枠とみなし排他ゾーン化

// ツールチップ crop 済み画像(または bbox)から行とグリフを切り出す
// 戻り値: [{y0,y1,x0,x1,bullet,glyphs:[{x0,x1,y0,y1,color,key,bitmap}]}]
export function segmentLines(img, bbox) {
  const cls = classifyPixels(img, bbox);
  const { map, w, h } = cls;
  // テキストマスク = 色分類ヒット OR 輝度155以上。
  // 画面共有(YUV)では色情報が潰れて色分類から漏れるが、輝度は保存されるため
  // 「形は輝度で取り、色はグリフ平均で決める」構成にする
  const { x = 0, y = 0 } = bbox || {};
  const mask = new Uint8Array(w * h);
  const d = img.data;
  for (let yy = 0; yy < h; yy++) {
    let src = ((y + yy) * img.width + x) * 4;
    let dst = yy * w;
    for (let xx = 0; xx < w; xx++, src += 4, dst++) {
      if (map[dst]) { mask[dst] = 1; continue; }
      const lum = d[src] * 0.299 + d[src + 1] * 0.587 + d[src + 2] * 0.114;
      if (lum >= 155) mask[dst] = 1;
    }
  }
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
    if (cw <= 2 && ch >= 17) return false; // 隣接パネル境界線などの縦棒(大フォントの'l'でも2x14まで)
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
    ln.glyphs = groups.filter((g, i) => {
      // 1pxグリフは'.'(ピリオド)として実在する。両隣から離れた孤立1pxだけノイズ扱い
      if (g.members.length === 1 && g.members[0].area <= 1) {
        const prev = groups[i - 1], next = groups[i + 1];
        const nearPrev = prev && g.x0 - prev.x1 <= 12;
        const nearNext = next && next.x0 - g.x1 <= 12;
        if (!nearPrev && !nearNext) return false;
      }
      return true;
    }).map((g) => {
      // グループ合成ビットマップ + グリフ平均色(クロマ劣化に頑健)
      const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
      const bits = new Uint8Array(gw * gh);
      let sr = 0, sg = 0, sb = 0, np = 0;
      for (const m of g.members) {
        for (const p of m.pixels) {
          const px = p % w, py = (p / w) | 0;
          bits[(py - g.y0) * gw + (px - g.x0)] = 1;
          const src = ((y + py) * img.width + (x + px)) * 4;
          sr += d[src]; sg += d[src + 1]; sb += d[src + 2];
          np++;
        }
      }
      const color = classifyMeanColor(sr / np, sg / np, sb / np);
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
      if (gw >= 4 && gw <= 10 && gh >= 4 && gh <= 10 && fill > 0.72 && first.color !== 'white') {
        ln.bullet = first.color;
        ln.glyphs.shift();
      }
    }
    delete ln.comps;
  }
  // 星列判定: 黄色の星形ブロブ(5-18px)が3個以上、ほぼ等間隔(9-16px)で並ぶ行。
  // OCR対象から外し、星数カウントに使う(上端検出が多少ずれても星が文字化けしない)
  for (const ln of lines) {
    const gs = ln.glyphs;
    if (gs.length >= 3 && gs.every((g) => {
      const gw = g.x1 - g.x0 + 1, gh = g.y1 - g.y0 + 1;
      return g.color === 'yellow' && gw >= 5 && gw <= 18 && gh >= 5 && gh <= 18;
    })) {
      // 星は11-13px間隔、5個ごとのグループ間はやや広い(〜20px)。
      // インベントリのアイコングリッド(44px間隔)はここで弾かれる
      let regular = 0;
      for (let i = 1; i < gs.length; i++) {
        const step = (gs[i].x0 + gs[i].x1) / 2 - (gs[i - 1].x0 + gs[i - 1].x1) / 2;
        if (step >= 9 && step <= 20) regular++;
      }
      if (regular >= gs.length - 3) ln.isStars = true;
    }
  }

  // 構造ルール: 星列はツールチップ最上部にあるので、最後の星列より上の非星行は
  // (検出上端の行き過ぎで入った)ツールチップ外のジャンク
  const lastStar = lines.reduce((acc, l, i) => (l.isStars ? i : acc), -1);
  const structural = lastStar > 0 ? lines.filter((l, i) => i >= lastStar || l.isStars) : lines;

  // 微小な単発グリフだけの行はノイズ
  return structural.filter((ln) => {
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
