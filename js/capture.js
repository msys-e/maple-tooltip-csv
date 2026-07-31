// 画面共有キャプチャループ + ペースト/D&D 受け口
// 安定判定(同一aHash連続)済みのツールチップcropをコールバックに渡す
import { findTooltip } from './detect.js';
import { aHash } from './imgproc.js';

const POLL_MS = 220;
const STABLE_COUNT = 2; // 同一ハッシュがこの回数連続したら確定

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
    this.processed = new Set(); // aHash → 処理済み
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
    const found = findTooltip(img);
    const info = { res: `${img.width}x${img.height}` };
    if (found.error) {
      const size = found.bbox ? ` [検出${found.bbox.w}x${found.bbox.h}]` : '';
      info.tip = ({ not_found: '検出待ち', clipped: '画面端で欠けています', bad_width: '幅が想定外(295-365px)' }[found.error]) + size;
      this.lastHash = null;
      this.stableN = 0;
      this.cb.onInfo(info);
      return;
    }
    // 矩形サイズも重複キーに含める(aHash衝突で別アイテムが握り潰されるのを軽減)
    const hash = `${aHash(img, found)}:${found.w}x${found.h}`;
    if (hash === this.lastHash) this.stableN++;
    else this.stableN = 0;
    this.lastHash = hash;
    if (this.stableN >= STABLE_COUNT && !this.processed.has(hash)) {
      this.processed.add(hash);
      info.tip = '認識中…';
      this.cb.onInfo(info);
      this.cb.onTooltip(img, found);
      return;
    }
    info.tip = this.processed.has(hash) ? '取得済み(次の装備へ)' : `検出 (${found.w}x${found.h})`;
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
  let depth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (++depth) document.body.classList.add('dragging'); });
  window.addEventListener('dragleave', () => { if (--depth <= 0) { depth = 0; document.body.classList.remove('dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    document.body.classList.remove('dragging');
    for (const f of e.dataTransfer?.files || []) {
      if (f.type.startsWith('image/')) onImage(await imageFromBlob(f));
    }
  });
}
