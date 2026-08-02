// UI・状態管理
import { segmentLines } from './segment.js';
import { GlyphBank, recognizeLines } from './ocr.js';
import { parseTooltip } from './parse.js';
import { findTooltip, countStars, TOOLTIP_MIN_W } from './detect.js';
import { downloadCSV, sanitizeFilenamePart } from './csv.js';
import * as store from './store.js';
import { CLASSES, classMainStat, flameUnsupportedReason } from './classes.js';
import { CaptureController, installDropPaste } from './capture.js';
import { parseRankingCSV, buildPlan, partOf, nearestLv, excludeReason, TABLE_LVS } from './enhance.js';
import {
  parseFlameData, flameEligibility, inferFlameAdvantaged, evaluateFlameItem,
  normalizeFlameSettings, migrateFlameSettings, formatFlamePercentile, DEFAULT_SECONDARY,
} from './flame.js';
import { Labeler } from './labeler.js';
import { initScouterUI } from './scouterui.js';

const $ = (id) => document.getElementById(id);

// ---------- 状態 ----------
let bank = new GlyphBank(null);
let items = store.loadItems();
let pending = []; // 未知グリフ待ちのcrop [{img, bbox, stars}]
const itemKeys = new Set(items.map(itemKey));
let scouterUi = null;

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
  if (!items.length) {
    wrap.innerHTML = '';
    if ($('tab-plan').style.display !== 'none') renderPlan();
    updateMeta();
    return;
  }

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
  if ($('tab-plan').style.display !== 'none') renderPlan(); // プラン表示中は装備追加に追従
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

function currentCharacter() {
  const id = store.getActiveCharacterId();
  return store.listCharacters().find((c) => c.id === id) || store.listCharacters()[0];
}

function activeClassName() {
  return currentCharacter()?.class || '';
}

function classDerivedAxes(className = activeClassName()) {
  if (!className) return null;
  const mainStat = classMainStat(className);
  if (!mainStat) {
    return { className, unsupportedReason: flameUnsupportedReason(className) };
  }
  return {
    className,
    mainStat,
    secondaryStat: DEFAULT_SECONDARY[mainStat],
    attackType: mainStat === 'INT' ? 'magic_att' : 'attack_power',
  };
}

function characterLabel(character) {
  const name = character?.name || '(名称未設定)';
  return character?.class ? `${name} (${character.class})` : name;
}

function activeCharacterNameForFile() {
  const name = sanitizeFilenamePart(currentCharacter()?.name);
  return name ? `_${name}` : '';
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  return `${(bytes / 1024).toFixed(1)} KB`;
}

function estimateLocalStorageBytes() {
  let total = 0;
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    total += (key.length + (localStorage.getItem(key)?.length || 0)) * 2;
  }
  return total;
}

function updateMeta() {
  $('info-count').textContent = items.length;
  $('bank-info').textContent = `${bank.size} glyphs`;
}

function renderCharacterControls() {
  const deferred = store.isMigrationDeferred();
  const chars = store.listCharacters();
  const activeId = store.getActiveCharacterId();
  $('char-select').innerHTML = chars
    .map((c) => `<option value="${esc(c.id)}">${esc(characterLabel(c))}</option>`)
    .join('');
  $('char-select').value = activeId;
  const active = chars.find((c) => c.id === activeId) || chars[0];
  $('char-class').value = active?.class || '';
  for (const id of ['char-select', 'char-class', 'btn-char-manage']) $(id).disabled = deferred;
  $('char-warning').style.display = deferred ? 'block' : 'none';
  $('char-warning').textContent = deferred
    ? '保存容量が不足しているためキャラ機能を利用できません。不要な装備やスナップショットを削除してページを再読み込みしてください。'
    : '';
}

function resetCharacterRuntimeState() {
  capture.processed.length = 0;
  pending = [];
  items = store.loadItems();
  itemKeys.clear();
  for (const it of items) itemKeys.add(itemKey(it));
  flameSettings = loadStoredFlameSettings();
  $('plan-stat').value = flameSettings.mainStat;
  syncFlameControls();
  scouterUi?.resetForCharacterSwitch();
  render();
  refreshSnapshots();
  renderCharacterControls();
}

function commitClassInput() {
  if (store.isMigrationDeferred()) return;
  const activeId = store.getActiveCharacterId();
  const value = $('char-class').value.trim();
  const active = currentCharacter();
  if (!value) {
    store.setCharacterClass(activeId, null);
    renderCharacterControls();
    renderCharacterModal();
    flameSettings = loadStoredFlameSettings();
    syncFlameControls();
    renderPlan();
    return;
  }
  if (!CLASSES.includes(value)) {
    $('char-class').value = active?.class || '';
    toast('Class は候補から選択してください', 'warn');
    return;
  }
  store.setCharacterClass(activeId, value);
  applyClassDerivedSettingsAfterChange(value);
  renderCharacterControls();
  renderCharacterModal();
}

function applyClassDerivedSettingsAfterChange(className) {
  const derived = classDerivedAxes(className);
  if (!derived?.mainStat) {
    syncFlameControls();
    renderFlamePlan();
    toast(derived?.unsupportedReason || `Class を ${className} に変更しました`);
    return;
  }
  flameSettings = normalizeFlameSettings({
    ...flameSettings,
    mainStat: derived.mainStat,
    secondaryStat: derived.secondaryStat,
    attackType: derived.attackType,
  });
  store.saveFlameSettings(flameSettings);
  syncFlameControls();
  renderPlan();
  toast(`Class を ${className} に変更しました (主ステ ${derived.mainStat} / 副ステ ${derived.secondaryStat} / ${derived.attackType === 'magic_att' ? 'MATT' : 'ATT'})`);
}

function renderCharacterModal() {
  if (!$('char-back').classList.contains('show')) return;
  const usage = store.characterStorageUsage();
  const activeId = store.getActiveCharacterId();
  const total = estimateLocalStorageBytes();
  const limit = 5 * 1024 * 1024;
  $('char-storage-summary').textContent =
    `localStorage 使用量: ${formatBytes(total)} / ${formatBytes(limit)}${total > limit * 0.85 ? '  容量が少なくなっています' : ''}`;
  let html = '<table><thead><tr><th></th><th>名前</th><th>Class</th><th>装備</th><th>スナップショット</th><th>容量</th><th>削除</th></tr></thead><tbody>';
  for (const c of usage) {
    html += `<tr data-char-id="${esc(c.id)}">` +
      `<td class="active-mark">${c.id === activeId ? '●' : ''}</td>` +
      `<td><input type="text" data-field="name" value="${esc(c.name)}"></td>` +
      `<td><input type="text" data-field="class" list="class-list" value="${esc(c.class || '')}"></td>` +
      `<td class="num">${c.items}</td>` +
      `<td class="num">${c.snapshots}</td>` +
      `<td class="num">${formatBytes(c.bytes)}</td>` +
      `<td><button class="danger" data-act="delete">削除</button></td>` +
      '</tr>';
  }
  html += '</tbody></table>';
  $('char-table-wrap').innerHTML = html;
}

function commitModalEdit(input) {
  const id = input.closest('tr')?.dataset.charId;
  if (!id) return;
  const value = input.value.trim();
  if (input.dataset.field === 'name') {
    store.renameCharacter(id, input.value);
  } else if (!value) {
    store.setCharacterClass(id, null);
  } else if (CLASSES.includes(value)) {
    store.setCharacterClass(id, value);
  } else {
    const current = store.listCharacters().find((c) => c.id === id);
    input.value = current?.class || '';
    toast('Class は候補から選択してください', 'warn');
    return;
  }
  if (id === store.getActiveCharacterId()) {
    if (value) applyClassDerivedSettingsAfterChange(value);
    else {
      flameSettings = loadStoredFlameSettings();
      syncFlameControls();
      renderPlan();
    }
  }
  renderCharacterControls();
  renderCharacterModal();
}

function deleteCharacterFromModal(id) {
  const usage = store.characterStorageUsage().find((c) => c.id === id);
  if (!usage) return;
  const details = [
    `キャラ「${usage.name || '(名称未設定)'}」を削除します。`,
    `装備${usage.items}件・スナップショット${usage.snapshots}件・スカウター入力${usage.scouterFields}件が消えます。`,
    '元に戻せません。',
  ].join('\n');
  if (!confirm(details)) return;
  const wasActive = store.getActiveCharacterId() === id;
  store.deleteCharacter(id);
  if (wasActive) resetCharacterRuntimeState();
  else {
    renderCharacterControls();
    renderCharacterModal();
  }
  toast('キャラを削除しました', 'warn');
}

function createCharacterFromModal() {
  if (store.isMigrationDeferred()) return;
  const name = prompt('新規キャラ名', '');
  if (name === null) return;
  const character = store.createCharacter({ name, class: null });
  if (!character) { toast('キャラを作成できませんでした', 'err'); return; }
  store.setActiveCharacter(character.id);
  resetCharacterRuntimeState();
  renderCharacterModal();
  toast('新規キャラを作成しました');
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

$('class-list').innerHTML = CLASSES.map((name) => `<option value="${esc(name)}"></option>`).join('');
$('char-select').addEventListener('change', () => {
  if (store.setActiveCharacter($('char-select').value)) {
    resetCharacterRuntimeState();
    toast(`キャラを切り替えました: ${characterLabel(currentCharacter())}`);
  }
});
$('char-class').addEventListener('change', commitClassInput);
$('char-class').addEventListener('blur', commitClassInput);
$('char-class').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    commitClassInput();
    e.target.blur();
  }
});
$('btn-char-manage').addEventListener('click', () => {
  if (store.isMigrationDeferred()) return;
  $('char-back').classList.add('show');
  renderCharacterModal();
});
$('btn-char-close').addEventListener('click', () => $('char-back').classList.remove('show'));
$('char-back').addEventListener('click', (e) => {
  if (e.target === $('char-back')) $('char-back').classList.remove('show');
});
$('btn-char-new').addEventListener('click', createCharacterFromModal);
$('char-table-wrap').addEventListener('change', (e) => {
  if (e.target.matches('input[data-field]')) commitModalEdit(e.target);
});
$('char-table-wrap').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target.matches('input[data-field]')) {
    e.preventDefault();
    commitModalEdit(e.target);
    e.target.blur();
  }
});
$('char-table-wrap').addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-act="delete"]');
  if (!btn) return;
  deleteCharacterFromModal(btn.closest('tr')?.dataset.charId);
});

// ---------- タブ・強化プラン ----------
let rankingTable = [];
let flameData = null;
let flameDataState = 'loading';
const DEFAULT_FLAME_SETTINGS = {
  settingsVersion: 2,
  mainStat: 'STR', secondaryStat: 'DEX', secondaryWeight: 0.1, allStatWeight: 10,
  attackWeight: 4, attackType: 'attack_power', sourceType: 'eternal_black',
};
function loadStoredFlameSettings() {
  const loaded = store.loadFlameSettings();
  const saved = loaded && typeof loaded === 'object' && !Array.isArray(loaded) ? loaded : {};
  const derived = classDerivedAxes();
  const normalized = migrateFlameSettings(derived?.mainStat ? {
    ...saved,
    mainStat: derived.mainStat,
    secondaryStat: derived.secondaryStat,
    attackType: derived.attackType,
  } : saved);
  // 旧版で既定値だったALL%=15だけを新しい既定値10へ移行する。
  // 旧保存形式(mainStatなし)は、組合せが食い違わないよう標準ペアへ移行する。
  // normalizeFlameSettings は固定順で返すが、比較は保存形式のキー順に依存しない値比較にする。
  if (!sameFlameSettings(saved, normalized)) {
    store.saveFlameSettings(normalized);
  }
  return normalized;
}

function sameFlameSettings(a, b) {
  return a.settingsVersion === b.settingsVersion &&
    a.mainStat === b.mainStat &&
    a.secondaryStat === b.secondaryStat &&
    Number(a.secondaryWeight) === b.secondaryWeight &&
    Number(a.allStatWeight) === b.allStatWeight &&
    Number(a.attackWeight) === b.attackWeight &&
    a.attackType === b.attackType &&
    a.sourceType === b.sourceType;
}
let flameSettings = loadStoredFlameSettings();
$('plan-stat').value = flameSettings.mainStat;
let planAllSteps = store.loadPlanAllSteps();
$('plan-all-steps').checked = planAllSteps;
$('plan-all-steps').addEventListener('change', () => {
  planAllSteps = $('plan-all-steps').checked;
  store.savePlanAllSteps(planAllSteps);
  renderEnhancePlan();
});

for (const btn of document.querySelectorAll('.tab-btn')) {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b === btn));
    // タブ追加時にここを触らなくて済むよう data-tab とパネルidの対応で回す
    for (const p of document.querySelectorAll('.panel[id^="tab-"]')) {
      p.style.display = p.id === `tab-${btn.dataset.tab}` ? 'block' : 'none';
    }
    if (btn.dataset.tab === 'plan') renderPlan();
  });
}

function syncFlameControls() {
  const derived = classDerivedAxes();
  flameSettings = normalizeFlameSettings(derived?.mainStat ? {
    ...flameSettings,
    mainStat: derived.mainStat,
    secondaryStat: derived.secondaryStat,
    attackType: derived.attackType,
  } : flameSettings);
  $('plan-stat').value = flameSettings.mainStat;
  $('flame-secondary-stat').value = flameSettings.secondaryStat;
  for (const option of $('flame-secondary-stat').options) {
    option.disabled = option.value === flameSettings.mainStat;
  }
  $('flame-secondary-weight').value = flameSettings.secondaryWeight;
  $('flame-all-weight').value = flameSettings.allStatWeight;
  $('flame-attack-weight').value = flameSettings.attackWeight;
  $('flame-attack-type').value = flameSettings.attackType;
  $('flame-source-type').value = flameSettings.sourceType;
  const classLocked = !!derived?.mainStat;
  const unsupported = !!derived?.unsupportedReason;
  $('plan-stat').disabled = classLocked;
  $('flame-secondary-stat').disabled = classLocked || unsupported;
  $('flame-attack-type').disabled = classLocked || unsupported;
  for (const id of ['flame-secondary-weight', 'flame-all-weight', 'flame-attack-weight', 'flame-source-type']) {
    $(id).disabled = unsupported;
  }
  $('flame-reset').disabled = unsupported;
  const note = $('class-derived-note');
  note.classList.toggle('warn', unsupported);
  note.textContent = unsupported ? `${derived.unsupportedReason} 強化プランは利用できます。` : derived
    ? `Class(${derived.className})から自動: 主ステ ${derived.mainStat} / 副ステ ${derived.secondaryStat} / ${derived.attackType === 'magic_att' ? 'MATT' : 'ATT'}`
    : '';
}

function numericControl(id, fallback) {
  const n = Number($(id).value);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function readFlameControls() {
  const derived = classDerivedAxes();
  flameSettings = normalizeFlameSettings({
    mainStat: derived?.mainStat || $('plan-stat').value,
    secondaryStat: derived?.secondaryStat || $('flame-secondary-stat').value,
    secondaryWeight: numericControl('flame-secondary-weight', 0.1),
    allStatWeight: numericControl('flame-all-weight', 10),
    attackWeight: numericControl('flame-attack-weight', 4),
    attackType: derived?.attackType || $('flame-attack-type').value,
    sourceType: $('flame-source-type').value,
  });
  syncFlameControls();
  store.saveFlameSettings(flameSettings);
}

$('plan-stat').addEventListener('change', () => {
  const mainStat = $('plan-stat').value;
  flameSettings.mainStat = mainStat;
  flameSettings.secondaryStat = DEFAULT_SECONDARY[mainStat];
  flameSettings.attackType = mainStat === 'INT' ? 'magic_att' : 'attack_power';
  store.saveFlameSettings(flameSettings);
  syncFlameControls();
  renderPlan();
});

for (const id of ['flame-secondary-stat', 'flame-secondary-weight', 'flame-all-weight',
  'flame-attack-weight', 'flame-attack-type', 'flame-source-type']) {
  $(id).addEventListener('change', () => { readFlameControls(); renderFlamePlan(); });
}
$('flame-reset').addEventListener('click', () => {
  const derived = classDerivedAxes();
  const mainStat = derived?.mainStat || $('plan-stat').value;
  flameSettings = {
    ...DEFAULT_FLAME_SETTINGS,
    mainStat,
    secondaryStat: derived?.secondaryStat || DEFAULT_SECONDARY[mainStat],
    attackType: derived?.attackType || (mainStat === 'INT' ? 'magic_att' : 'attack_power'),
  };
  store.saveFlameSettings(flameSettings);
  syncFlameControls();
  renderFlamePlan();
  toast('転生スコア係数を参考値に戻しました', 'warn');
});
syncFlameControls();

function potSummary(it) {
  return [1, 2, 3].map((n) => it[`pot${n}_text`]).filter(Boolean)
    .map((t) => t.replace(/\s*\+/, '+').replace(/All Stats/i, 'ALL').replace(/Attack Power/i, '攻').replace(/Boss Damage/i, 'ボス').replace(/Critical Damage/i, 'クリダメ').replace(/:\s*/, ''))
    .join(' · ');
}

function renderPlan() {
  renderEnhancePlan();
  renderFlamePlan();
}

function renderEnhancePlan() {
  const wrap = $('plan-wrap');
  if (!rankingTable.length) {
    wrap.innerHTML = '<div style="color:var(--ink-dim);padding:20px">強化効率表(data/ranking.csv)が読み込めていません</div>';
    $('plan-summary').textContent = '';
    $('plan-notes').textContent = '';
    return;
  }
  const mainStat = $('plan-stat').value;
  const plan = buildPlan(items, rankingTable, mainStat, { includeFuture: planAllSteps });
  const mode = planAllSteps
    ? `全段階 / 今できる ${plan.filter((p) => p.immediate).length} 件`
    : '今できる一手のみ';
  $('plan-summary').textContent =
    `対象 ${new Set(plan.map((p) => p.item)).size} 装備 / ${plan.length} アクション (メソ/スコア効率順・${mode})`;
  if (!plan.length) {
    wrap.innerHTML = '<div style="color:var(--ink-dim);padding:20px">適用可能な強化がありません(装備一覧タブで装備を取り込んでください)</div>';
    $('plan-notes').textContent = '';
    return;
  }
  let html = '<table><thead><tr><th>#</th><th>アイテム</th><th>部位/Lv</th><th>現状</th><th>強化内容</th><th>設定</th><th>期待メソ(B)</th><th>スコア</th><th class="grp-star">メソ/スコア(M)</th></tr></thead><tbody>';
  plan.forEach((p, i) => {
    const it = p.item, r = p.row;
    const cur = r.kind === 'star' ? `★${it.star_count}` : potSummary(it);
    // 全段階モードでは「今すぐ実行できる行」と「先の段階」を見分けられるようにする
    const future = p.immediate === false;
    const badge = future ? '<span class="plan-later">先</span>' : '';
    html += `<tr${future ? ' class="plan-future"' : ''}>` +
      `<td class="rank">${i + 1}</td>` +
      `<td class="name" data-v="${esc(it.item_name)}">${esc(it.item_name)}</td>` +
      `<td data-v="${esc(partOf(it.equip_type) ?? '')}">${esc(partOf(it.equip_type) ?? '')} Lv${nearestLv(it.req_level_base ?? it.req_level)}</td>` +
      `<td class="cur">${esc(cur)}</td>` +
      `<td data-v="${esc(r.item)}">${badge}${esc(r.item)}</td>` +
      `<td data-v="${esc(r.setting)}">${esc(r.setting)}</td>` +
      `<td data-v="${r.meso}">${r.meso}</td>` +
      `<td data-v="${r.score}">${r.score}</td>` +
      `<td class="mps" data-v="${r.mps}">${r.mps}</td></tr>`;
  });
  html += '</tbody></table>';
  wrap.innerHTML = html;
  // 対象外の注記(適用行が1つもない装備のみ)
  const planned = new Set(plan.map((p) => p.item));
  const notes = [];
  for (const it of items) {
    if (planned.has(it)) continue;
    notes.push(`${it.item_name}: ${excludeReason(it, rankingTable, mainStat)}`);
  }
  const lvNote = items.some((it) => {
    const lv = it.req_level_base ?? it.req_level;
    return Number.isFinite(lv) && !TABLE_LVS.includes(lv);
  }) ? '※表にないLvの装備は最寄りのLv(120→100、140→150等)に丸めて評価しています' : '';
  const modeNote = planAllSteps
    ? '※「先」付きは今すぐ実行できない先の段階です。同じ装備で目標が両立しない行(主ステ%含む/除く、攻撃%/攻撃%orボス等)も並びます'
    : '';
  $('plan-notes').innerHTML = [lvNote, modeNote, notes.length ? `対象外: ${notes.map(esc).join(' ／ ')}` : '']
    .filter(Boolean).join('<br>');
}

function fmtScore(n) {
  return Number.isInteger(n) ? String(n) : Number(n).toFixed(1).replace(/\.0$/, '');
}

function fmtImprovementProbability(probability) {
  const percent = probability * 100;
  if (percent >= 10) return `${percent.toFixed(1)}%`;
  if (percent >= 1) return `${percent.toFixed(2)}%`;
  if (percent >= 0.01) return `${percent.toFixed(3)}%`;
  return `${percent.toPrecision(2)}%`;
}

function fmtExpectedAttempts(evaluation) {
  const probability = evaluation.improvementProbability;
  if (probability === null || probability === undefined) return '—';
  if (probability <= 0 || !Number.isFinite(evaluation.expectedAttempts)) return '到達不可 (0%)';
  const expected = evaluation.expectedAttempts;
  const maximumFractionDigits = expected < 10 ? 2 : expected < 100 ? 1 : 0;
  const count = expected.toLocaleString('ja-JP', { maximumFractionDigits });
  return `${count}個 (${fmtImprovementProbability(probability)})`;
}

function advantageOptions(resolved) {
  const autoLabel = resolved.source === 'name' ? '推定: ボス転生あり' : '不明 (要指定)';
  return `<option value="auto" ${!resolved.source.startsWith('manual') ? 'selected' : ''}>${autoLabel}</option>` +
    `<option value="true" ${resolved.source === 'manual' && resolved.value ? 'selected' : ''}>ボス転生あり</option>` +
    `<option value="false" ${resolved.source === 'manual' && !resolved.value ? 'selected' : ''}>ボス転生なし (通常)</option>` +
    `<option value="fixed" ${resolved.source === 'manual_fixed' ? 'selected' : ''}>特殊固定Tier (対象外)</option>`;
}

function renderFlamePlan() {
  const wrap = $('flame-wrap');
  const derived = classDerivedAxes();
  if (derived?.unsupportedReason) {
    const message = `${derived.unsupportedReason} 強化プランは利用できます。`;
    wrap.innerHTML = `<div style="color:var(--ink-dim);padding:20px">${esc(message)}</div>`;
    $('flame-summary').textContent = '転生更新チェック非対応';
    $('flame-notes').textContent = message;
    return;
  }
  if (!flameData) {
    const message = flameDataState === 'error'
      ? '転生確率データの読み込みに失敗しました。ページを再読み込みしてください。'
      : '転生確率データを読み込み中です';
    wrap.innerHTML = `<div style="color:var(--ink-dim);padding:20px">${message}</div>`;
    $('flame-summary').textContent = '';
    $('flame-notes').textContent = '';
    return;
  }
  const settings = { ...flameSettings, mainStat: $('plan-stat').value };
  const rows = [];
  const weaponNames = [];
  let excluded = 0;
  for (let index = 0; index < items.length; index++) {
    const item = items[index];
    const eligibility = flameEligibility(item);
    if (eligibility.kind === 'weapon') { weaponNames.push(item.item_name); continue; }
    if (eligibility.kind !== 'non_weapon') { excluded++; continue; }
    const advantage = inferFlameAdvantaged(item);
    const evaluation = evaluateFlameItem(item, flameData, settings, advantage.value);
    rows.push({ index, item, advantage, evaluation });
  }
  rows.sort((a, b) => a.evaluation.band.rank - b.evaluation.band.rank ||
    (a.evaluation.percentile ?? 2) - (b.evaluation.percentile ?? 2) || a.evaluation.score - b.evaluation.score);
  const ready = rows.filter((r) => r.evaluation.percentile !== null).length;
  $('flame-summary').textContent = `判定 ${ready}/${rows.length} 装備 · 弱い順`;
  if (!rows.length) {
    wrap.innerHTML = '<div style="color:var(--ink-dim);padding:20px">判定できる非武器の転生装備がありません</div>';
  } else {
    let html = '<table><thead><tr><th>#</th><th>判定</th><th>アイテム</th><th>部位 / IL</th><th>転生区分</th><th>スコア</th><th>位置</th><th>平均個数 (更新確率)</th><th>基準 (80 / 95 / 99 / 99.9%)</th><th>内訳</th></tr></thead><tbody>';
    rows.forEach(({ index, item, advantage, evaluation }, i) => {
      const ev = evaluation;
      const pct = formatFlamePercentile(ev.percentile);
      const expectedAttempts = fmtExpectedAttempts(ev);
      const targets = ev.unsupportedReason ? '対象外' : !ev.valid ? '転生値を確認' : ev.targets
        ? `${fmtScore(ev.targets.p80)} / ${fmtScore(ev.targets.p95)} / ${fmtScore(ev.targets.p99)} / ${fmtScore(ev.targets.p999)}`
        : 'ボス転生を指定';
      const attackLabel = settings.attackType === 'magic_att' ? 'MATT' : 'ATT';
      const details = ev.unsupportedReason ? ev.unsupportedReason : ev.valid
        ? `${settings.mainStat} ${ev.mainBonus} + ${settings.secondaryStat} ${ev.secondaryBonus}×${settings.secondaryWeight} + ` +
          `ALL ${ev.allBonus}×${settings.allStatWeight} + ${attackLabel} ${ev.attackBonus}×${settings.attackWeight}`
        : `不正な転生値: ${ev.invalidFields.join(', ')}`;
      const scoreText = ev.unsupportedReason ? '—' : ev.valid ? fmtScore(ev.score) : '—';
      html += `<tr class="band-${ev.band.key}">` +
        `<td class="rank">${i + 1}</td>` +
        `<td><span class="flame-band ${ev.band.key}">${ev.band.label}</span></td>` +
        `<td class="name">${esc(item.item_name)}</td>` +
        `<td>${esc(partOf(item.equip_type) ?? item.equip_type ?? '')} / IL${ev.eligibility.itemLevel}</td>` +
        `<td><select class="flame-advantage" data-item-index="${index}" aria-label="${esc(item.item_name)}の転生区分">${advantageOptions(advantage)}</select></td>` +
        `<td class="score" data-v="${scoreText}">${scoreText}</td>` +
        `<td class="percentile" data-v="${pct}">${pct}</td>` +
        `<td class="expectation" data-v="${expectedAttempts}">${expectedAttempts}</td>` +
        `<td data-v="${targets}">${targets}</td>` +
        `<td class="cur" title="${esc(details)}">${esc(details)}</td></tr>`;
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;
  }
  const notes = [];
  const invalidRows = rows.filter((r) => !r.evaluation.valid);
  if (invalidRows.length) notes.push(`転生値が不正な ${invalidRows.length}件は判定を保留しています。再取得またはJSONデータを確認してください。`);
  if (rows.some((r) => r.advantage.value === null)) notes.push('「不明」の装備はボス転生の有無を指定すると判定できます。既知の装備名に一致した場合だけ「推定: ボス転生あり」と表示します。');
  const fixedRows = rows.filter((r) => r.advantage.value === 'fixed');
  if (fixedRows.length) notes.push(`特殊な固定Tier装備として指定した ${fixedRows.length}件は確率判定の対象外です。`);
  if (weaponNames.length) notes.push(`武器は基礎攻撃力依存のため今回の順位から除外: ${weaponNames.map(esc).join('、')}`);
  if (excluded) notes.push(`転生対象外・部位不明 ${excluded}件は非表示です。`);
  notes.push('判定区分: 80%未満=最優先、80–95%=更新候補、95–99%=平均以上、99–99.9%=良好、99.9%以上=最高水準。');
  notes.push('平均個数は、現在スコアを厳密に上回る結果が出るまでの期待消費数（1 ÷ 1回の更新確率）です。同点は更新に含みません。');
  $('flame-notes').innerHTML = notes.join('<br>');
}

$('flame-wrap').addEventListener('change', (e) => {
  const select = e.target.closest('select.flame-advantage');
  if (!select) return;
  const item = items[Number(select.dataset.itemIndex)];
  if (!item) return;
  if (select.value === 'auto') delete item.flame_advantaged;
  else if (select.value === 'fixed') item.flame_advantaged = 'fixed';
  else item.flame_advantaged = select.value === 'true';
  store.saveItems(items);
  renderFlamePlan();
});

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
    // PNGだと1枚250KB前後で20件程度でlocalStorage上限(5MiB)に達するためJPEGで保存
    item.thumb = canvas.toDataURL('image/jpeg', 0.82);
    store.saveItems(newItems);
  } catch {
    delete item.thumb; // localStorage容量超過時はサムネイルなしで保存
    try {
      store.saveItems(newItems);
      if (!silent) toast('容量不足のためサムネイルなしで保存しました', 'warn');
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
  // スカウタータブがSTAT画面を取り込んでいる間だけ、フレームの処理をそちらへ委譲する
  onTooltip: (img, bbox) => (statHandler ? statHandler(img, bbox) : processTooltip(img, bbox)),
});
let statHandler = null;

// スカウタータブ用: 任意の矩形を本番と同じ経路(crop→分割→認識)で読む
function recognizeRegion(img, bbox) {
  const { canvas, sub } = cropToCanvas(img, bbox);
  return { rec: recognizeLines(segmentLines(sub), bank), canvas };
}

// 未知グリフをラベラーへ積む(STAT画面はフォントが違うので初回は必ず出る)
function reportUnknowns(rec, canvas) {
  let n = 0;
  for (const ln of rec) for (const g of ln.unknowns || []) { labeler.add(g, lineCanvas(canvas, ln)); n++; }
  if (!n) return;
  $('unknown-count').textContent = labeler.count;
  $('unknown-banner').classList.add('show');
  toast(`未知の文字 ${labeler.count} 件 — ラベル付けすると読み取れるようになります`, 'warn');
}

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
  downloadCSV(items, `maple_items${activeCharacterNameForFile()}_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`);
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
    renderCharacterControls();
    items = store.loadItems();
    flameSettings = loadStoredFlameSettings();
    $('plan-stat').value = flameSettings.mainStat;
    syncFlameControls();
    itemKeys.clear();
    for (const it of items) itemKeys.add(itemKey(it));
    scouterUi?.resetForCharacterSwitch();
    for (const [k, v] of Object.entries(store.loadUserBank())) bank.add(k, v);
    render();
    refreshSnapshots();
    const switched = summary.activeCharacterName ? ` · 「${summary.activeCharacterName}」に切り替えました` : '';
    toast(`インポート: キャラ 新規${summary.characters}件 / 更新${summary.updated}件 / アイテム${summary.items}件 / スナップショット${summary.snapshots}件${switched}`);
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

// 旧形式(PNG)のサムネイルをJPEGへ変換して容量を約1/10に圧縮する。
// PNGのままだと20件強で5MiB上限に達し、以降の装備がサムネイルなしになる
async function migrateThumbs() {
  const migrating = items;
  const targets = items.filter((it) => it.thumb?.startsWith('data:image/png'));
  if (!targets.length) return;
  let done = 0;
  for (const it of targets) {
    try {
      const im = new Image();
      const ok = await new Promise((res) => { im.onload = () => res(true); im.onerror = () => res(false); im.src = it.thumb; });
      if (!ok) continue;
      const c = document.createElement('canvas');
      c.width = im.naturalWidth;
      c.height = im.naturalHeight;
      c.getContext('2d').drawImage(im, 0, 0);
      it.thumb = c.toDataURL('image/jpeg', 0.82);
      done++;
    } catch { /* 個別の変換失敗はスキップして残りを続行 */ }
  }
  // await中にインポート/クリア等でitemsが差し替わっていたら旧配列への変換は捨てる(次回起動で再移行)
  if (items !== migrating || !done) return;
  try {
    store.saveItems(items);
    render();
    toast(`サムネイル${done}件を圧縮形式に変換しました`);
  } catch { /* 保存失敗時はlocalStorage上PNGのまま(次回起動で再移行) */ }
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
  try {
    rankingTable = parseRankingCSV(await (await fetch(`data/ranking.csv?v=${Date.now()}`)).text());
  } catch {
    toast('強化効率表(ranking.csv)の読み込みに失敗しました', 'warn');
  }
  try {
    const [tierProbabilitiesText, lineProbabilitiesText] = await Promise.all([
      fetch(`data/flame_tier_probabilities.csv?v=${Date.now()}`).then((r) => {
        if (!r.ok) throw new Error('flame_tier_probabilities');
        return r.text();
      }),
      fetch(`data/flame_line_probabilities.csv?v=${Date.now()}`).then((r) => {
        if (!r.ok) throw new Error('flame_line_probabilities');
        return r.text();
      }),
    ]);
    flameData = parseFlameData({ tierProbabilitiesText, lineProbabilitiesText });
    flameDataState = 'ready';
  } catch {
    flameDataState = 'error';
    toast('転生確率データの読み込みに失敗しました', 'warn');
  }
  renderColPanel();
  render();
  refreshSnapshots();
  scouterUi = initScouterUI({
    toast,
    copyText,
    chime,
    recognizeRegion,
    reportUnknowns,
    capture: {
      // 古いキャッシュのcapture.jsが読まれていると setDetector が生えていない
      supported: typeof capture.setDetector === 'function',
      running: () => capture.running,
      start: () => capture.start(),
      setDetector: (fn, opts) => capture.setDetector(fn, opts),
      onFrame: (fn) => { statHandler = fn; },
    },
  });
  renderCharacterControls();
  migrateThumbs();
})();
