// 汎用画素処理: 色分類・連結成分・投影・aHash
// image は {width, height, data: Uint8ClampedArray(RGBA)} — canvas ImageData 互換

// 色クラス
export const C = {
  NONE: 0,
  WHITE: 1,   // 素値・本文
  YELLOW: 2,  // スターフォース増分・星アイコン・Unique
  CYAN: 3,    // 転生ステータス増分
  ORANGE: 4,  // アイテム名注記・警告
  GREEN: 5,   // ポテンシャル(Legendary)
  PURPLE: 6,  // ポテンシャル(Epic)
};

export const COLOR_NAMES = ['none', 'white', 'yellow', 'cyan', 'orange', 'green', 'purple'];

// 2系統の入力を受ける: スクショの鮮明色と、画面共有(YUV 4:2:0)で褪せた色。
//   実測: 黄 (240,192,0)→(208,192,128) / 緑 (192,240,0)→(192,224,128)
//        水色 (0,224,160)→(96,176,160) / 白 (240,240,240)は不変
// 絶対値でなくチャンネル間の相対関係で判定する。
export function classifyPixel(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx < 150) return C.NONE;
  if (mn > 140 && mx - mn < 60) return C.WHITE;
  // オレンジ: 赤が緑を大きく上回る(黄はr-g≤48なのでr-g≥60で分離)
  if (r >= 200 && g >= 90 && g < 180 && b < 110 && r - g >= 60) return C.ORANGE;
  // 黄: 赤≥緑>青。褪せると青が128まで浮く
  if (r > 190 && g > 150 && r >= g + 10 && b <= g - 40 && r - b >= 60) return C.YELLOW;
  // 緑: 緑>赤、青は緑より十分低い(水色はg-bが小さいので分離)
  if (g > 200 && g >= r + 20 && b <= g - 80) return C.GREEN;
  // 水色: 緑>赤+50、青が高く緑に近い
  if (g > 150 && g >= r + 50 && b >= 110 && g - b < 70) return C.CYAN;
  // Epic紫(176,112,240)。褪せで青が~200まで落ちても拾う。背景紫ノイズ(b~160)は除外
  if (b >= 185 && b >= r + 15 && g < r) return C.PURPLE;
  return C.NONE;
}

// グリフ平均色の分類(セグメント後の色意味づけ用)。
// 画面共有でクロマが潰れても、グリフ全画素の平均なら色相は保たれる
export function classifyMeanColor(r, g, b) {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (mx - mn < 45 || mn > 150) return C.WHITE;
  if (b > r && b > g + 35) return C.PURPLE;
  if (g > r + 20) return (g - b >= 70) ? C.GREEN : C.CYAN;
  // 黄/橙境界: ブレットや星は縁の暗色で平均が橙寄りに沈むため橙は強い赤優位のみ
  if (r - g >= 80) return C.ORANGE;
  return C.YELLOW;
}

// 画像全体(または bbox 内)のクラスマップを返す
export function classifyPixels(img, bbox) {
  const { x = 0, y = 0, w = img.width, h = img.height } = bbox || {};
  const map = new Uint8Array(w * h);
  const d = img.data;
  for (let yy = 0; yy < h; yy++) {
    let src = ((y + yy) * img.width + x) * 4;
    let dst = yy * w;
    for (let xx = 0; xx < w; xx++, src += 4, dst++) {
      map[dst] = classifyPixel(d[src], d[src + 1], d[src + 2]);
    }
  }
  return { map, w, h };
}

// 8近傍連結成分。mask: Uint8Array(0/非0)。
// 戻り値: [{x0,y0,x1,y1,area,pixels:[idx...]}] (x1,y1は含む)
export function connectedComponents(mask, w, h, keepPixels = true) {
  const labels = new Int32Array(w * h);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i++) {
    if (!mask[i] || labels[i]) continue;
    const id = comps.length + 1;
    const comp = { x0: w, y0: h, x1: 0, y1: 0, area: 0, pixels: keepPixels ? [] : null };
    stack.length = 0;
    stack.push(i);
    labels[i] = id;
    while (stack.length) {
      const p = stack.pop();
      const px = p % w, py = (p / w) | 0;
      comp.area++;
      if (keepPixels) comp.pixels.push(p);
      if (px < comp.x0) comp.x0 = px;
      if (px > comp.x1) comp.x1 = px;
      if (py < comp.y0) comp.y0 = py;
      if (py > comp.y1) comp.y1 = py;
      for (let dy = -1; dy <= 1; dy++) {
        const ny = py + dy;
        if (ny < 0 || ny >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = px + dx;
          if (nx < 0 || nx >= w) continue;
          const n = ny * w + nx;
          if (mask[n] && !labels[n]) { labels[n] = id; stack.push(n); }
        }
      }
    }
    comps.push(comp);
  }
  return comps;
}

// 成分の2値ビットマップ(幅x高さ)を取り出す
export function componentBitmap(comp, w) {
  const bw = comp.x1 - comp.x0 + 1, bh = comp.y1 - comp.y0 + 1;
  const bits = new Uint8Array(bw * bh);
  for (const p of comp.pixels) {
    const px = p % w, py = (p / w) | 0;
    bits[(py - comp.y0) * bw + (px - comp.x0)] = 1;
  }
  return { w: bw, h: bh, bits };
}

// ビットマップ → hex文字列キー
export function bitmapKey(bm) {
  let hex = '';
  let acc = 0, n = 0;
  for (let i = 0; i < bm.bits.length; i++) {
    acc = (acc << 1) | bm.bits[i];
    n++;
    if (n === 4) { hex += acc.toString(16); acc = 0; n = 0; }
  }
  if (n) hex += (acc << (4 - n)).toString(16);
  return `${bm.w}x${bm.h}:${hex}`;
}

export function hammingBits(a, b) {
  // 同サイズ前提
  let d = 0;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) d++;
  return d;
}

// 領域の average hash (16x16, 明度) — 安定判定・重複排除用
export function aHash(img, bbox) {
  const { x, y, w, h } = bbox;
  const N = 16;
  const vals = new Float64Array(N * N);
  const d = img.data;
  for (let gy = 0; gy < N; gy++) {
    for (let gx = 0; gx < N; gx++) {
      const sx0 = x + Math.floor(gx * w / N), sx1 = x + Math.floor((gx + 1) * w / N);
      const sy0 = y + Math.floor(gy * h / N), sy1 = y + Math.floor((gy + 1) * h / N);
      let sum = 0, cnt = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        let p = (sy * img.width + sx0) * 4;
        for (let sx = sx0; sx < sx1; sx++, p += 4) {
          sum += d[p] * 0.299 + d[p + 1] * 0.587 + d[p + 2] * 0.114;
          cnt++;
        }
      }
      vals[gy * N + gx] = cnt ? sum / cnt : 0;
    }
  }
  let mean = 0;
  for (const v of vals) mean += v;
  mean /= vals.length;
  let hex = '', acc = 0, n = 0;
  for (const v of vals) {
    acc = (acc << 1) | (v > mean ? 1 : 0);
    if (++n === 4) { hex += acc.toString(16); acc = 0; n = 0; }
  }
  return hex;
}

export function hammingHex(a, b) {
  if (a.length !== b.length) return 999;
  let d = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) { d += x & 1; x >>= 1; }
  }
  return d;
}
