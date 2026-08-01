// 画面共有キャプチャループ + ペースト/D&D 受け口
// 安定判定(同一aHash連続)済みのツールチップcropをコールバックに渡す
import { findTooltip } from './detect.js';
import { aHash, hammingHex } from './imgproc.js';

const POLL_MS = 220;
const STABLE_COUNT = 2; // 同一ハッシュがこの回数連続したら確定

const ERR_MSG = {
  not_found: '検出待ち',
  clipped: '画面端で欠けています',
  bad_width: '幅が想定外(295-365px)',
};

export class CaptureController {
  // cb: { onState(text, live), onInfo({res,tip}), onTooltip(img, bbox, canvas) }
  constructor(cb) {
    this.cb = cb;
    this.stream = null;
    this.timer = null;
    this.video = document.getElementById('preview');
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.lastHash = null;
    this.stableN = 0;
    this.processed = []; // {ah, size} 処理済み(ハミング許容つき照合)
    this.detector = null;  // null = 既定の装備ツールチップ検出
    this.hashSkipTop = 0;
  }

  // 装備ツールチップ以外(STATウィンドウ等)を拾いたいときに検出関数を差し替える。
  // fn(img) の戻り値契約は findTooltip と同一: {x,y,w,h} または {error, bbox?}
  //   hashSkipTop: 安定判定のハッシュから除外する上端px(アニメする帯がある場合のみ)
  // 検出対象が変わると processed の照合も無意味になるのでリセットする
  setDetector(fn, { hashSkipTop = 0 } = {}) {
    this.detector = fn || null;
    this.hashSkipTop = fn ? hashSkipTop : 0;
    this.resetProcessed();
  }

  // 同じ画面をもう一度取り込みたいとき(取り込みステップの切り替え時など)に呼ぶ
  resetProcessed() {
    this.processed = [];
    this.lastHash = null;
    this.stableN = 0;
  }

  _isProcessed(ah, size) {
    return this.processed.some((p) => p.size === size && hammingHex(p.ah, ah) <= 6);
  }

  get running() { return !!this.stream; }

  async start() {
    this.stream = await navigator.mediaDevices.getDisplayMedia({
      video: { frameRate: 15 },
      audio: false,
    });
    this.video.srcObject = this.stream;
    this.stream.getVideoTracks()[0].addEventListener('ended', () => this.stop());
    this.timer = setInterval(() => this._tick(), POLL_MS);
    this.cb.onState('共有中', true);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.stream) for (const t of this.stream.getTracks()) t.stop();
    this.stream = null;
    this.video.srcObject = null;
    this.lastHash = null;
    this.stableN = 0;
    this.cb.onState('待機中', false);
  }

  _tick() {
    const v = this.video;
    if (!v.videoWidth) return;
    if (this.canvas.width !== v.videoWidth) {
      this.canvas.width = v.videoWidth;
      this.canvas.height = v.videoHeight;
    }
    this.ctx.drawImage(v, 0, 0);
    const img = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height);
    this.lastFrame = img; // 診断保存用
    const found = (this.detector || findTooltip)(img);
    const info = { res: `${img.width}x${img.height}` };
    if (found.error) {
      const size = found.bbox ? ` [検出${found.bbox.w}x${found.bbox.h}]` : '';
      // 差し替えた検出関数が独自のエラーコードを返したらそのまま出す
      info.tip = (ERR_MSG[found.error] || found.error) + size;
      this.lastHash = null;
      this.stableN = 0;
      this.cb.onInfo(info);
      return;
    }
    // 安定判定はaHash単独(bbox±1pxのジッタで安定カウンタがリセットされないように)、
    // 処理済みキーには矩形サイズも含める(aHash衝突で別アイテムが握り潰されるのを軽減)
    // ★23以上の星キラキラはアニメーションして毎フレーム変わるため、
    // ハッシュ対象は星帯を除いた下側(テキスト領域)に限定する
    const skip = this.detector
      ? Math.min(this.hashSkipTop, Math.max(0, found.h - 8))
      : Math.min(120, Math.floor(found.h / 3));
    const stableRegion = { x: found.x, y: found.y + skip, w: found.w, h: found.h - skip };
    const ah = aHash(img, stableRegion);
    // 本文領域に流れてきたキラキラ粒子で数ビット揺れても「同一」とみなす
    if (this.lastHash && hammingHex(ah, this.lastHash) <= 6) this.stableN++;
    else this.stableN = 0;
    this.lastHash = ah;
    const size = `${found.w}x${found.h}`;
    if (this.stableN >= STABLE_COUNT && !this._isProcessed(ah, size)) {
      info.tip = '認識中…';
      this.cb.onInfo(info);
      const result = this.cb.onTooltip(img, found);
      // error(保存失敗)/lowq(エフェクト被り等で品質低) は処理済みにせず次フレームで再試行
      if (result !== 'error' && result !== 'lowq') this.processed.push({ ah, size });
      if (result === 'lowq') {
        info.tip = '認識品質低(エフェクト被り?) — 再試行中';
        this.cb.onInfo(info);
      }
      return;
    }
    info.tip = this._isProcessed(ah, size) ? '取得済み(次の装備へ)' : `検出 (${found.w}x${found.h})`;
    this.cb.onInfo(info);
  }
}

// ペースト/D&D: File/Blob → ImageData
export function imageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const im = new Image();
    im.onload = () => {
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(im, 0, 0);
      URL.revokeObjectURL(url);
      resolve(ctx.getImageData(0, 0, c.width, c.height));
    };
    im.onerror = reject;
    im.src = url;
  });
}

export function installDropPaste(onImage) {
  window.addEventListener('paste', async (e) => {
    for (const it of e.clipboardData?.items || []) {
      if (it.type.startsWith('image/')) onImage(await imageFromBlob(it.getAsFile()));
    }
  });
  // 受け付けるのはファイル(スクリーンショット)のドラッグだけ。
  // 何でも preventDefault すると、ページ内のリンク(スカウター連携のブックマークレット)を
  // ブックマークバーへドラッグしようとしたときにページ側がドロップ先を横取りしてしまう
  const hasFiles = (e) => Array.from(e.dataTransfer?.types || []).includes('Files');
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    if (++depth) document.body.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', async (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    for (const f of e.dataTransfer?.files || []) {
      if (f.type.startsWith('image/')) onImage(await imageFromBlob(f));
    }
  });
}
