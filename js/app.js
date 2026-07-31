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
// 取得音: 矩形波ビープは不評だったため、サイン波の減衰付きソフトチャイムに
function chime(kind = 'success') {
  try {
    audioCtx = audioCtx || new AudioContext();
    const t0 = audioCtx.currentTime;
    // success: C5→G5の柔らかい2音 / warn: G4の1音(控えめ)
    const notes = kind === 'success' ? [[523.25, 0], [783.99, 0.09]] : [[392, 0]];
    for (const [freq, dt] of notes) {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = 'sine';
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0 + dt);
      g.gain.exponentialRampToValueAtTime(0.05, t0 + dt + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + dt + 0.35);
      o.connect(g).connect(audioCtx.destination);
      o.start(t0 + dt);
      o.stop(t0 + dt + 0.4);
    }
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
// 表の列定義(ユーザー指定の固定レイアウト)。転生=水色内訳(_bonus)
const TABLE_COLS = [
  ['str_total', 'STR', ''],
  ['str_bonus', 'STR転生', 'c-bonus'],
  ['dex_total', 'DEX', ''],
  ['dex_bonus', 'DEX転生', 'c-bonus'],
  ['luk_total', 'LUK', ''],
  ['luk_bonus', 'LUK転生', 'c-bonus'],
  ['all_stats_pct_total', 'ALLstats', 'c-bonus'],
  ['attack_power_total', '攻撃力', ''],
  ['attack_power_bonus', '攻撃力転生', 'c-bonus'],
  ['magic_att_total', '魔力', ''],
  ['magic_att_bonus', '魔力転生', 'c-bonus'],
  ['boss_damage_pct_bonus', 'Boss転生', 'c-bonus'],
  ['damage_pct_bonus', 'Dmage転生', 'c-bonus'],
];

// 合計セルのtitleに内訳(素+スタフォ+転生)を出す
function breakdownTitle(it, col) {
  if (!col.endsWith('_total')) return '';
  const base = col.slice(0, -6);
  const parts = [];
  if (it[`${base}_base`] !== undefined) parts.push(`素${it[`${base}_base`]}`);
  if (it[`${base}_star`] !== undefined) parts.push(`スタフォ+${it[`${base}_star`]}`);
  if (it[`${base}_bonus`] !== undefined) parts.push(`転生+${it[`${base}_bonus`]}`);
  return parts.join(' ');
}

// 全列定義(表示制御・ソートの単位)
const COL_DEFS = [
  { key: 'item_name', label: 'アイテム', cls: 'name', str: true },
  { key: 'equip_type', label: '種別', cls: '', str: true },
  { key: 'star_count', label: '★', cls: 'stars', star: true },
  ...TABLE_COLS.map(([key, label, cls]) => ({ key, label, cls })),
  { key: 'pot1_text', label: '潜在1', str: true, pot: 1 },
  { key: 'pot2_text', label: '潜在2', str: true, pot: 2 },
  { key: 'pot3_text', label: '潜在3', str: true, pot: 3 },
];

let colVis = (() => {
  try { return JSON.parse(localStorage.getItem('mtc:cols')) || {}; } catch { return {}; }
})();
const isVisible = (key) => colVis[key] !== false;
let sortState = null; // {key, dir: 1|-1}
const filters = new Map(); // colKey -> Set(許可する値の文字列表現)。未登録=フィルタなし

const filterKeyOf = (v) => (v === undefined || v === '' ? '' : String(v));

function sortedView() {
  let view = items.map((it, i) => ({ it, i }));
  for (const [key, allowed] of filters) {
    view = view.filter(({ it }) => allowed.has(filterKeyOf(it[key])));
  }
  if (sortState) {
    const { key, dir } = sortState;
    const def = COL_DEFS.find((d) => d.key === key);
    view.sort((a, b) => {
      const ea = a.it[key] === undefined || a.it[key] === '';
      const eb = b.it[key] === undefined || b.it[key] === '';
      if (ea && eb) return 0;
      if (ea) return 1;  // 空値は常に末尾
      if (eb) return -1;
      if (def?.str) return String(a.it[key]).localeCompare(String(b.it[key])) * dir;
      const na = Number(a.it[key]), nb = Number(b.it[key]);
      if (Number.isNaN(na)) return 1; // 数値化できない値(誤読等)は末尾
      if (Number.isNaN(nb)) return -1;
      return (na - nb) * dir;
    });
  }
  return view;
}

function render() {
  const wrap = $('table-wrap');
  $('empty-hint').style.display = items.length ? 'none' : 'block';
  if (!items.length) { wrap.innerHTML = ''; updateMeta(); return; }

  const cols = COL_DEFS.filter((d) => isVisible(d.key));
  let html = '<table><thead><tr><th></th>';
  for (const d of cols) {
    const arrow = sortState?.key === d.key ? (sortState.dir === 1 ? ' ▲' : ' ▼') : '';
    const fActive = filters.has(d.key);
    html += `<th class="sortable ${d.cls === 'c-bonus' ? 'grp-bonus' : ''} ${d.star ? 'grp-star' : ''}" data-sort="${d.key}">` +
      `${d.label}${arrow}<span class="flt ${fActive ? 'active' : ''}" data-flt="${d.key}" title="値で絞り込み">▼</span></th>`;
  }
  html += '<th></th></tr></thead><tbody>';
  for (const { it, i } of sortedView()) {
    html += `<tr data-idx="${i}">`;
    html += `<td class="thumb">${it.thumb ? `<img src="${it.thumb}" alt="">` : ''}</td>`;
    for (const d of cols) {
      const v = it[d.key];
      if (v === undefined || v === '') { html += '<td></td>'; continue; }
      if (d.key === 'item_name') {
        html += `<td class="name" data-v="${esc(v)}" title="取得: ${esc((it.timestamp || '').replace('T', ' ').slice(0, 16))}">${esc(v)}</td>`;
      } else if (d.star) {
        html += `<td class="stars" data-v="${v}">★${v}</td>`;
      } else if (d.pot) {
        html += `<td class="grade-${it[`pot${d.pot}_grade`] || ''}" data-v="${esc(v)}" title="${esc(it[`pot${d.pot}_grade`] || '')}">${esc(v)}</td>`;
      } else {
        html += `<td class="${d.cls}" data-v="${esc(v)}" title="${esc(breakdownTitle(it, d.key))}">${esc(v)}</td>`;
      }
    }
    html += '<td class="del" title="この行を削除">×</td></tr>';
  }
  html += '</tbody></table>';
  wrap.innerHTML = html;
  for (const th of wrap.querySelectorAll('th.sortable')) {
    th.addEventListener('click', (e) => {
      if (e.target.closest('.flt')) { openFilterMenu(e.target.closest('.flt')); return; }
      const key = th.dataset.sort;
      sortState = (sortState?.key === key)
        ? (sortState.dir === 1 ? { key, dir: -1 } : null) // 昇順→降順→解除
        : { key, dir: 1 };
      render();
    });
  }
  updateMeta();
}

// Excelのオートフィルタ風: 列の値一覧チェックボックスで絞り込み
function openFilterMenu(fltEl) {
  const key = fltEl.dataset.flt;
  const def = COL_DEFS.find((d) => d.key === key);
  const menu = $('filter-menu');
  const values = [...new Set(items.map((it) => filterKeyOf(it[key])))];
  values.sort((a, b) => {
    if (a === '') return 1;
    if (b === '') return -1;
    return def?.str ? a.localeCompare(b) : Number(a) - Number(b);
  });
  const allowed = filters.get(key);
  menu.innerHTML =
    `<div class="fm-head">${def?.label ?? key} で絞り込み</div>` +
    values.map((v) =>
      `<label><input type="checkbox" value="${esc(v)}" ${!allowed || allowed.has(v) ? 'checked' : ''}> ${v === '' ? '(空白)' : esc(v)}</label>`
    ).join('') +
    '<div class="fm-actions"><button data-act="all">全て</button><button data-act="none">なし</button><button data-act="close">適用して閉じる</button></div>';
  const rect = fltEl.getBoundingClientRect();
  menu.style.left = `${Math.min(rect.left, window.innerWidth - 260)}px`;
  menu.style.top = `${rect.bottom + 4 + window.scrollY}px`;
  menu.style.display = 'block';

  const apply = () => {
    const checked = new Set([...menu.querySelectorAll('input:checked')].map((c) => c.value));
    if (checked.size === values.length) filters.delete(key); // 全選択=フィルタなし
    else filters.set(key, checked);
    render();
  };
  for (const cb of menu.querySelectorAll('input')) cb.addEventListener('change', apply);
  for (const b of menu.querySelectorAll('button')) {
    b.addEventListener('click', () => {
      if (b.dataset.act === 'all') { menu.querySelectorAll('input').forEach((c) => { c.checked = true; }); apply(); }
      else if (b.dataset.act === 'none') { menu.querySelectorAll('input').forEach((c) => { c.checked = false; }); apply(); }
      else menu.style.display = 'none';
    });
  }
}

document.addEventListener('click', (e) => {
  const menu = $('filter-menu');
  if (menu.style.display !== 'none' && !e.target.closest('#filter-menu') && !e.target.closest('.flt')) {
    menu.style.display = 'none';
  }
});

// 列表示チェックボックスパネル
function renderColPanel() {
  const panel = $('col-panel');
  panel.innerHTML = COL_DEFS.map((d) =>
    `<label><input type="checkbox" data-col="${d.key}" ${isVisible(d.key) ? 'checked' : ''}> ${d.label}</label>`
  ).join('');
  for (const cb of panel.querySelectorAll('input')) {
    cb.addEventListener('change', () => {
      colVis[cb.dataset.col] = cb.checked;
      localStorage.setItem('mtc:cols', JSON.stringify(colVis));
      if (!cb.checked && sortState?.key === cb.dataset.col) sortState = null; // 見えない列でのソート残留を防ぐ
      render();
    });
  }
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

$('btn-cols').addEventListener('click', () => {
  const p = $('col-panel');
  p.style.display = p.style.display === 'none' ? 'flex' : 'none';
});

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
  // ツールチップ外領域の未知はラベラーに積まない:
  //  - 名前行より上(上端の行き過ぎ) / 認識3文字未満のジャンク行(下端の行き過ぎ)
  const preItem = parseTooltip(rec, stars);
  const nameY = preItem._name_y ?? -1;
  const realChars = (ln) => (ln.text || '').replace(/[�\s]/g, '').length;
  // 本文の最終行(認識3文字以上)より下だけを「下端ジャンク」とみなす。
  // 本文中の未知だらけの行(新出テキスト等)はラベラーに届く
  const lastRealY = Math.max(-1, ...rec.filter((l) => realChars(l) >= 3).map((l) => l.y0));
  const unknowns = rec.flatMap((ln) => {
    if (nameY >= 0 && ln.y1 < nameY - 2) return [];
    if (realChars(ln) < 3 && ln.y0 > lastRealY) return [];
    return ln.unknowns.map((g) => ({ g, ln }));
  });
  if (unknowns.length) {
    lastUnknownFrame = img; // 診断用: 未知が出たフレームを保持
    console.log('[mtc] unknowns', unknowns.map(({ g }) => g.key));
    for (const { g, ln } of unknowns) labeler.add(g, lineCanvas(canvas, ln));
    pending.push({ img, bbox });
    $('unknown-count').textContent = labeler.count;
    $('unknown-banner').classList.add('show');
    if (!silent) {
      chime('warn');
      toast(`未知の文字 ${labeler.count} 件 — ラベル付けしてください`, 'warn');
      labeler.open();
    }
    return 'unknowns';
  }
  const item = preItem;
  delete item._name_y;
  // 品質ゲート: 名前は読めたのにステータスも潜在も無い → エフェクト被り等で
  // 文字が輝度飽和に飲まれた可能性が高い。取り込まず次のフレームに任せる
  const statTotals = Object.keys(item).filter((k) => k.endsWith('_total') && item[k] !== undefined).length;
  if (item.item_name && statTotals === 0 && !item.potential_grade) {
    if (!silent) toast(`認識品質が低いため再試行: ${item.item_name}`, 'warn');
    return 'lowq';
  }
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
  chime('success');
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

let lastUnknownFrame = null;

function savePng(img, name) {
  const c = document.createElement('canvas');
  c.width = img.width;
  c.height = img.height;
  c.getContext('2d').putImageData(img, 0, 0);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = name;
  a.click();
}

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
$('btn-unknown-frame').addEventListener('click', (e) => {
  e.stopPropagation(); // バナー本体のラベラー起動を抑止
  if (!lastUnknownFrame) { toast('未知発生フレームがありません', 'warn'); return; }
  savePng(lastUnknownFrame, `unknown_frame_${Date.now()}.png`);
  toast('未知発生フレームを保存しました');
});
$('btn-frame-burst').addEventListener('click', () => {
  // キラキラ等のアニメーション診断用: 3秒間、500ms間隔で6枚保存
  let shot = 0;
  toast('3秒間バースト保存します — 装備にホバーしてください', 'warn');
  const t = setInterval(() => {
    if (capture.lastFrame) savePng(capture.lastFrame, `burst_${Date.now()}_${shot}.png`);
    if (++shot >= 6) { clearInterval(t); toast('バースト保存完了(6枚)'); }
  }, 500);
});

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
  capture.processed.length = 0;
  store.saveItems(items);
  render();
  toast('クリアしました', 'warn');
});

// ---------- 起動 ----------
$('btn-bank-reset').addEventListener('click', async () => {
  if (!confirm('このブラウザで学習した文字ラベル(手動ラベル+自動学習)を全て消去し、同梱辞書に戻しますか?\n(取得済みアイテムとスナップショットは消えません)')) return;
  // 先に同梱辞書の再取得を成功させてから消す(失敗時に旧ラベルが残ったまま
  // 成功表示になり、onLearnで消したはずのデータが復活するのを防ぐ)
  let fresh;
  try {
    fresh = new GlyphBank(await (await fetch(`data/glyphbank.json?v=${Date.now()}`)).json());
  } catch {
    toast('同梱辞書の再取得に失敗したためリセットを中止しました', 'err');
    return;
  }
  store.saveUserBank({});
  bank = fresh;
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
  renderColPanel();
  render();
  refreshSnapshots();
})();
