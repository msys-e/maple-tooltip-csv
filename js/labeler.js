// 未知グリフのラベル付けモーダル
// queue: [{key, bitmap, context:{canvas,x0,y0,x1,y1}}] — key単位で一意
export class Labeler {
  constructor(onLabel, onDone) {
    this.queue = [];
    this.seen = new Set();
    this.onLabel = onLabel; // (key, label) => void
    this.onDone = onDone;   // キューが空になった
    this.back = document.getElementById('labeler-back');
    this.zoom = document.getElementById('glyph-zoom');
    this.ctxCanvas = document.getElementById('glyph-context');
    this.input = document.getElementById('labeler-input');
    this.progress = document.getElementById('labeler-progress');
    document.getElementById('labeler-ok').onclick = () => this._commit(this.input.value);
    document.getElementById('labeler-ignore').onclick = () => this._commit('');
    document.getElementById('labeler-skip').onclick = () => { this.queue.push(this.queue.shift()); this._show(); };
    document.getElementById('labeler-close').onclick = () => this.close();
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this._commit(this.input.value);
      if (e.key === 'Escape') this.close();
    });
  }

  get count() { return this.queue.length; }

  add(glyph, lineCanvas) {
    if (this.seen.has(glyph.key)) return;
    this.seen.add(glyph.key);
    this.queue.push({ key: glyph.key, bitmap: glyph.bitmap, lineCanvas, gx: glyph.x0, gy: glyph.y0 });
  }

  open() {
    if (!this.queue.length) return;
    this.back.classList.add('show');
    this._show();
  }

  close() {
    this.back.classList.remove('show');
  }

  _show() {
    const item = this.queue[0];
    if (!item) { this.close(); this.onDone(); return; }
    this.progress.textContent = `残り ${this.queue.length}`;
    const S = 10;
    const bm = item.bitmap;
    this.zoom.width = bm.w * S;
    this.zoom.height = bm.h * S;
    const zc = this.zoom.getContext('2d');
    zc.fillStyle = '#23232e';
    zc.fillRect(0, 0, this.zoom.width, this.zoom.height);
    zc.fillStyle = '#f0f0f0';
    for (let y = 0; y < bm.h; y++) {
      for (let x = 0; x < bm.w; x++) {
        if (bm.bits[y * bm.w + x]) zc.fillRect(x * S, y * S, S - 1, S - 1);
      }
    }
    // 前後の文脈(行画像 + 対象グリフ枠)
    if (item.lineCanvas) {
      const lc = item.lineCanvas;
      const S2 = 3;
      this.ctxCanvas.width = lc.width * S2;
      this.ctxCanvas.height = lc.height * S2;
      const cc = this.ctxCanvas.getContext('2d');
      cc.imageSmoothingEnabled = false;
      cc.drawImage(lc, 0, 0, this.ctxCanvas.width, this.ctxCanvas.height);
      cc.strokeStyle = '#f0c000';
      cc.lineWidth = 2;
      cc.strokeRect((item.gx - 1) * S2, 0, (item.bitmap.w + 2) * S2, this.ctxCanvas.height);
      this.ctxCanvas.style.display = 'block';
    } else {
      this.ctxCanvas.style.display = 'none';
    }
    this.input.value = '';
    this.input.focus();
  }

  _commit(label) {
    const item = this.queue.shift();
    if (item) this.onLabel(item.key, label);
    this._show();
  }
}
