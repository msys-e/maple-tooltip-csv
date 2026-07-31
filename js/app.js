// UI・状態管理
import { segmentLines } from './segment.js';
import { GlyphBank, recognizeLines } from './ocr.js';
import { parseTooltip } from './parse.js';
import { findTooltip, countStars, TOOLTIP_MIN_W } from './detect.js';
import { downloadCSV } from './csv.js';
import * as store from './store.js';
import { CaptureController, installDropPaste } from './capture.js';
import { Labeler } from './labeler.js';

const $ = (id) => document.getElementById(id);

// ---------- 状態 ----------
let bank = new GlyphBank(null);
let items = store.loadItems();
let pending = []; // 未知グリフ待ちのcrop [{img, bbox, stars}]
const itemKeys = new Set(items.map(itemKey));

function itemKey(it) {
  return [it.item_name, it.star_count, it.str_total, it.dex_total, it.int_total, it.luk_total,
    it.attack_power_total, it.magic_att_total, it.pot1_text, it.pot2_text, it.pot3_text].join('|');
}

// ---------- 通知 ----------
function toast(msg, cls = '') {
  const el = document.createElement('div');
  el.className = `toast ${cls}`;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

let audioCtx = null;
function beep(freq = 880, dur = 0.07) {
  try {
    audioCtx = audioCtx || new AudioContext();
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    o.type = 'square';
    o.frequency.value = freq;
    g.gain.value = 0.04;
    o.connect(g).connect(audioCtx.destination);
    o.start();
    o.stop(audioCtx.currentTime + dur);
  } catch { /* 音は出なくてもよい */ }
}

// ---------- クリップボード ----------
async function copyText(text, cell) {
  try {
    await navigator.clipboard.writeText(String(text));
    toast(`コピー: ${text}`);
    if (cell) {
      cell.classList.add('copied');
      setTimeout(() => cell.classList.remove('copied'), 500);
    }
  } catch {
    toast('コピーに失敗しました', 'err');
  }
}

// ---------- テーブル ----------
const STAT_DEFS = [
  ['str', 'STR'], ['dex', 'DEX'], ['int', 'INT'], ['luk', 'LUK'],
  ['max_hp', 'HP'], ['max_mp', 'MP'],
  ['attack_power', '攻撃力'], ['magic_att', '魔力'], ['defense', '防御'],
  ['all_stats_pct', 'ALL%'], ['boss_damage_pct', 'ボスダメ%'], ['ignore_def_pct', '防御無視%'],
];

function statCell(it, base) {
  const t = it[`${base}_total`];
  if (t === undefined) return '';
  const parts = [];
  if (it[`${base}_base`] !== undefined) parts.push(`<span class="bd" data-v="${it[`${base}_base`]}">${it[`${base}_base`]}</span>`);
  if (it[`${base}_star`] !== undefined) parts.push(`<span class="bd c-star" data-v="${it[`${base}_star`]}">+${it[`${base}_star`]}</span>`);
  if (it[`${base}_bonus`] !== undefined) parts.push(`<span class="bd c-bonus" data-v="${it[`${base}_bonus`]}">+${it[`${base}_bonus`]}</span>`);
  const bd = parts.length ? ` <small style="opacity:.75">(${parts.join(' ')})</small>` : '';
  return `<b data-v="${t}">${t}</b>${bd}`;
}

function render() {
  const wrap = $('table-wrap');
  $('empty-hint').style.display = items.length ? 'none' : 'block';
  if (!items.length) { wrap.innerHTML = ''; updateMeta(); return; }

  const activeStats = STAT_DEFS.filter(([b]) => items.some((it) => it[`${b}_total`] !== undefined));
  const hasPot = items.some((it) => it.pot1_text);
  let html = '<table><thead><tr><th></th><th>アイテム</th><th class="grp-star">★</th>';
  for (const [, label] of activeStats) html += `<th>${label}</th>`;
  if (hasPot) html += '<th>潜在</th><th>潜在1</th><th>潜在2</th><th>潜在3</th>';
  html += '<th>取得日時</th><th></th></tr></thead><tbody>';
  items.forEach((it, idx) => {
    html += `<tr data-idx="${idx}">`;
    html += `<td class="thumb">${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}</td>`;
    html += `<td class="name" data-v="${esc(it.item_name)}">${esc(it.item_name)}</td>`;
    html += `<td class="stars" data-v="${it.star_count}">★${it.star_count}</td>`;
    for (const [b] of activeStats) html += `<td>${statCell(it, b)}</td>`;
    if (hasPot) {
      html += `<td class="grade-${it.potential_grade}" data-v="${esc(it.potential_grade || '')}">${esc(it.potential_grade || '')}</td>`;
      for (const n of [1, 2, 3]) {
        const t = it[`pot${n}_text`] || '';
        html += `<td class="grade-${it[`pot${n}_grade`] || ''}" data-v="${esc(t)}" title="${esc(it[`pot${n}_grade`] || '')}">${esc(t)}</td>`;
      }
    }
    const ts = (it.timestamp || '').replace('T', ' ').slice(5, 16);
    html += `<td data-v="${esc(it.timestamp || '')}">${esc(ts)}</td>`;
    html += '<td class="del" title="この行を削除">×</td></tr>';
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  updateMeta();
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

function updateMeta() {
  $('info-count').textContent = items.length;
  $('bank-info').textContent = `${bank.size} glyphs`;
}

$('table-wrap').addEventListener('click', (e) => {
  const tr = e.target.closest('tr[data-idx]');
  if (!tr) return;
  const idx = +tr.dataset.idx;
  if (e.target.classList.contains('del')) {
    const [removed] = items.splice(idx, 1);
    itemKeys.delete(itemKey(removed));
    store.saveItems(items);
    render();
    toast('1件削除しました', 'warn');
    return;
  }
  if (e.target.closest('td.thumb')) {
    const it = items[idx];
    if (it?.thumb) {
      $('zoom-img').src = it.thumb;
      $('zoom-back').classList.add('show');
    }
    return;
  }
  // 内訳スパン優先、なければセル値をコピー
  const bd = e.target.closest('.bd, b[data-v]');
  const cell = e.target.closest('td[data-v], td');
  const v = bd?.dataset.v ?? cell?.dataset.v ?? cell?.querySelector('[data-v]')?.dataset.v;
  if (v !== undefined && v !== '') copyText(v, cell);
});
$('zoom-back').addEventListener('click', () => $('zoom-back').classList.remove('show'));

// ---------- 認識パイプライン ----------
function cropToCanvas(img, bbox) {
  const c = document.createElement('canvas');
  c.width = bbox.w;
  c.height = bbox.h;
  const ctx = c.getContext('2d');
  const sub = new ImageData(new Uint8ClampedArray(bbox.w * bbox.h * 4), bbox.w, bbox.h);
  for (let y = 0; y < bbox.h; y++) {
    const s = ((bbox.y + y) * img.width + bbox.x) * 4;
    sub.data.set(img.data.subarray(s, s + bbox.w * 4), y * bbox.w * 4);
  }
  ctx.putImageData(sub, 0, 0);
  return { canvas: c, sub };
}

function lineCanvas(cropCanvas, ln) {
  const c = document.createElement('canvas');
  const pad = 3;
  const y0 = Math.max(0, ln.y0 - pad);
  c.width = cropCanvas.width;
  c.height = Math.min(cropCanvas.height, ln.y1 + pad + 1) - y0;
  c.getContext('2d').drawImage(cropCanvas, 0, -y0);
  return c;
}

function processTooltip(img, bbox, { silent = false } = {}) {
  const stars = countStars(img, bbox);
  const { canvas, sub } = cropToCanvas(img, bbox);
  const lines = segmentLines(sub);
  const rec = recognizeLines(lines, bank);
  const unknowns = rec.flatMap((ln) => ln.unknowns.map((g) => ({ g, ln })));
  if (unknowns.length) {
    for (const { g, ln } of unknowns) labeler.add(g, lineCanvas(canvas, ln));
    pending.push({ img, bbox });
    $('unknown-count').textContent = labeler.count;
    $('unknown-banner').classList.add('show');
    if (!silent) {
      beep(440);
      toast(`未知の文字 ${labeler.count} 件 — ラベル付けしてください`, 'warn');
      labeler.open();
    }
    return 'unknowns';
  }
  const item = parseTooltip(rec, stars);
  const key = itemKey(item);
  if (itemKeys.has(key)) {
    if (!silent) toast(`重複スキップ: ${item.item_name}`, 'warn');
    return 'duplicate';
  }
  const newItems = [...items, item];
  try {
    item.thumb = canvas.toDataURL('image/png');
    store.saveItems(newItems);
  } catch {
    delete item.thumb; // localStorage容量超過時はサムネイルなしで保存
    try {
      store.saveItems(newItems);
    } catch {
      if (!silent) toast('保存に失敗しました(localStorage容量を確認)', 'err');
      return 'error'; // itemKeysに入れず、再ホバーでリトライ可能なままにする
    }
  }
  itemKeys.add(key);
  items.push(item);
  render();
  const tr = $('table-wrap').querySelector(`tr[data-idx="${items.length - 1}"]`);
  if (tr) tr.classList.add('new-row');
  beep(880);
  toast(`追加: ${item.item_name} ★${item.star_count}`);
  return 'added';
}

function processImage(img) {
  let bbox = findTooltip(img);
  if (bbox.error === 'not_found' && img.width < 400) {
    bbox = { x: 0, y: 0, w: img.width, h: img.height }; // ツールチップ単体のスクショ
  } else if (bbox.error) {
    toast({ not_found: 'ツールチップが見つかりません', clipped: 'ツールチップが画面端で欠けています', bad_width: `ツールチップ幅が想定外です(基準${TOOLTIP_MIN_W}px〜)` }[bbox.error], 'err');
    return;
  }
  processTooltip(img, bbox);
}

function reprocessPending() {
  const list = pending;
  pending = [];
  let ok = 0;
  for (const p of list) {
    const r = processTooltip(p.img, p.bbox, { silent: true });
    if (r === 'unknowns') { /* まだ未知が残る → pendingに再登録済み */ }
    else if (r === 'added') ok++;
  }
  if (ok) toast(`ラベル反映で ${ok} 件追加されました`);
  if (!labeler.count) $('unknown-banner').classList.remove('show');
  else $('unknown-count').textContent = labeler.count;
}

// ---------- ラベラー ----------
const labeler = new Labeler(
  (key, label) => {
    bank.add(key, label);
    const user = store.loadUserBank();
    user[key] = label;
    store.saveUserBank(user);
    updateMeta();
  },
  () => reprocessPending()
);
$('unknown-banner').addEventListener('click', () => labeler.open());

// ---------- キャプチャ ----------
const capture = new CaptureController({
  onState: (text, live) => {
    $('status').textContent = text;
    $('status').classList.toggle('live', live);
    $('btn-capture').textContent = live ? '共有を停止' : '画面共有を開始';
    $('capture-panel').style.display = live ? 'block' : 'none';
  },
  onInfo: (info) => {
    if (info.res) $('info-res').textContent = info.res;
    if (info.tip) $('info-tip').textContent = info.tip;
  },
  onTooltip: (img, bbox) => processTooltip(img, bbox),
});

$('btn-capture').addEventListener('click', async () => {
  if (capture.running) { capture.stop(); return; }
  try {
    await capture.start();
    toast('ゲームウィンドウを選択しました。装備にマウスを乗せてください');
  } catch {
    toast('画面共有がキャンセルされました', 'warn');
  }
});

installDropPaste((img) => processImage(img));

function saveCurrentFrame() {
  const img = capture.lastFrame;
  if (!img) { toast('共有中のフレームがありません', 'warn'); return; }
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `frame_${Date.now()}.png`;
  a.click();
}
$('btn-frame-save').addEventListener('click', saveCurrentFrame);
$('btn-frame-save-delay').addEventListener('click', () => {
  // ボタンを押してからゲームへ移ってホバーする猶予を作る
  let left = 3;
  toast('3秒後にフレームを保存します — 装備にホバーしてください', 'warn');
  const t = setInterval(() => {
    if (--left <= 0) { clearInterval(t); saveCurrentFrame(); toast('フレームを保存しました'); }
  }, 1000);
});

// ---------- CSV / スナップショット / エクスポート ----------
$('btn-csv').addEventListener('click', () => {
  if (!items.length) { toast('アイテムがありません', 'warn'); return; }
  downloadCSV(items);
});

function refreshSnapshots() {
  const sel = $('snapshot-list');
  const snaps = store.listSnapshots();
  sel.innerHTML = '<option value="">スナップショット…</option>' +
    snaps.map((s) => `<option value="${s.id}">${esc(s.name)} (${s.ts.slice(0, 16).replace('T', ' ')}) ${s.items.length}件</option>`).join('');
}

$('btn-snapshot').addEventListener('click', () => {
  if (!items.length) { toast('アイテムがありません', 'warn'); return; }
  const name = prompt('スナップショット名', new Date().toLocaleDateString('ja-JP'));
  if (name === null) return;
  store.saveSnapshot(name, items);
  refreshSnapshots();
  toast(`スナップショット「${name}」を保存しました (${items.length}件)`);
});

$('btn-restore').addEventListener('click', () => {
  const id = $('snapshot-list').value;
  if (!id) { toast('スナップショットを選択してください', 'warn'); return; }
  const snap = store.getSnapshot(id);
  if (!snap) return;
  items = structuredClone(snap.items);
  itemKeys.clear();
  for (const it of items) itemKeys.add(itemKey(it));
  store.saveItems(items);
  render();
  toast(`「${snap.name}」を復元しました (${items.length}件)`);
});

$('btn-snap-del').addEventListener('click', () => {
  const id = $('snapshot-list').value;
  if (!id) { toast('スナップショットを選択してください', 'warn'); return; }
  const snap = store.getSnapshot(id);
  if (!confirm(`スナップショット「${snap?.name}」を削除しますか?`)) return;
  store.deleteSnapshot(id);
  refreshSnapshots();
  toast('削除しました', 'warn');
});

$('btn-export').addEventListener('click', () => {
  const blob = new Blob([store.exportAll()], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `maple_tooltip_backup_${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
});

$('btn-import').addEventListener('click', () => $('import-file').click());
$('import-file').addEventListener('change', async (e) => {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const summary = store.importAll(await f.text(), true);
    items = store.loadItems();
    itemKeys.clear();
    for (const it of items) itemKeys.add(itemKey(it));
    for (const [k, v] of Object.entries(store.loadUserBank())) bank.add(k, v);
    render();
    refreshSnapshots();
    toast(`インポート: アイテム${summary.items}件 / スナップショット${summary.snapshots}件`);
  } catch {
    toast('インポートに失敗しました(JSON形式を確認)', 'err');
  }
  e.target.value = '';
});

$('btn-clear').addEventListener('click', () => {
  if (!items.length) return;
  if (!confirm(`表の ${items.length} 件をクリアしますか?\n(スナップショットは残ります)`)) return;
  items = [];
  itemKeys.clear();
  capture.processed.clear();
  store.saveItems(items);
  render();
  toast('クリアしました', 'warn');
});

// ---------- 起動 ----------
$('btn-bank-reset').addEventListener('click', async () => {
  if (!confirm('このブラウザで学習した文字ラベル(手動ラベル+自動学習)を全て消去し、同梱辞書に戻しますか?\n(取得済みアイテムとスナップショットは消えません)')) return;
  store.saveUserBank({});
  try {
    bank = new GlyphBank(await (await fetch(`data/glyphbank.json?v=${Date.now()}`)).json());
  } catch { /* 次回リロードで復旧 */ }
  installLearnHook();
  updateMeta();
  toast('学習辞書をリセットしました', 'warn');
});

function installLearnHook() {
  // ファジー照合で学習した変種キーをlocalStorageにも残し、次回起動から即ヒットさせる
  bank.onLearn = (key, label) => {
    const user = store.loadUserBank();
    user[key] = label;
    store.saveUserBank(user);
  };
}

(async () => {
  try {
    const res = await fetch(`data/glyphbank.json?v=${Date.now()}`); // 古いキャッシュ対策
    bank = new GlyphBank(await res.json());
  } catch {
    toast('同梱グリフ辞書の読み込みに失敗しました', 'err');
  }
  for (const [k, v] of Object.entries(store.loadUserBank())) bank.add(k, v);
  installLearnHook();
  render();
  refreshSnapshots();
})();
