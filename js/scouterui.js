// スカウター連携タブのDOM層(app.js肥大回避のため分離)
import { SCOUTER_FIELDS, GROUP_LABELS, SLOTS, buildDiff, buildBookmarklet } from './scouter.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

let toast = () => {};
let copyText = () => {};
let form = { slot: '1', values: {} };

function inputId(key) {
  return `sc-f-${key}`;
}

function renderForm() {
  const wrap = $('scouter-form');
  let html = '';
  for (const group of ['char', 'stat', 'popup']) {
    const fields = SCOUTER_FIELDS.filter((f) => f.group === group);
    if (!fields.length) continue;
    html += `<div class="sc-group"><h3>${GROUP_LABELS[group]}</h3><div class="sc-grid">`;
    for (const f of fields) {
      const v = form.values[f.key] ?? '';
      html += `<label class="sc-field" title="${f.hint || ''}">` +
        `<span class="sc-label">${f.label}${f.unit ? ` <em>${f.unit}</em>` : ''}</span>` +
        `<input type="text" inputmode="decimal" id="${inputId(f.key)}" data-key="${f.key}" value="${String(v).replace(/"/g, '&quot;')}" autocomplete="off">` +
        '</label>';
    }
    html += '</div></div>';
  }
  wrap.innerHTML = html;
}

function collectValues() {
  const values = {};
  for (const f of SCOUTER_FIELDS) {
    const el = $(inputId(f.key));
    const v = el ? el.value.trim() : '';
    if (v !== '') values[f.key] = v;
  }
  return values;
}

function persist() {
  form = { slot: $('scouter-slot').value, values: collectValues() };
  try {
    store.saveScouter(form);
  } catch { /* 容量超過などは無視(次回起動時に復元されないだけ) */ }
}

function updateSlotLabels(slot) {
  for (const el of document.querySelectorAll('.sc-slot-n')) el.textContent = slot;
}

// 生成し直すたびに <a> のhrefを差し替える。ユーザーには「古いブックマークは消す」旨を案内
function build() {
  persist();
  const diff = buildDiff(form.values);
  const n = Object.keys(diff).length;
  if (!n) {
    toast('1つ以上の項目を入力してください', 'warn');
    return;
  }
  const href = buildBookmarklet(diff, form.slot);
  const link = $('scouter-link');
  link.href = href;
  link.textContent = `📥 スカウターに反映 (プリセット${form.slot})`;
  $('scouter-out').style.display = 'block';
  $('scouter-diff').textContent =
    Object.entries(diff).map(([k, v]) => `${k}=${v}`).join('  ');
  $('scouter-built-info').textContent =
    `${n} 項目 / ${href.length} 文字 — このボタンをブックマークバーへドラッグしてください`;
  updateSlotLabels(form.slot);
  toast(`ブックマークレットを生成しました (${n}項目)`);
}

export function initScouterUI(deps = {}) {
  if (deps.toast) toast = deps.toast;
  if (deps.copyText) copyText = deps.copyText;

  form = store.loadScouter();
  if (!form || typeof form !== 'object') form = { slot: '1', values: {} };
  if (!SLOTS.includes(String(form.slot))) form.slot = '1';
  if (!form.values || typeof form.values !== 'object') form.values = {};

  renderForm();
  $('scouter-slot').value = form.slot;
  updateSlotLabels(form.slot);

  $('scouter-form').addEventListener('input', persist);
  $('scouter-slot').addEventListener('change', () => {
    persist();
    updateSlotLabels(form.slot);
    // スロットを変えたら焼き込み済みのブックマークレットは別物になるので隠す
    $('scouter-out').style.display = 'none';
  });
  $('btn-scouter-build').addEventListener('click', build);
  $('btn-scouter-clear').addEventListener('click', () => {
    for (const f of SCOUTER_FIELDS) {
      const el = $(inputId(f.key));
      if (el) el.value = '';
    }
    persist();
    $('scouter-out').style.display = 'none';
    toast('入力をクリアしました', 'warn');
  });

  // ページ上でクリックしても意味がない(このサイトのlocalStorageを触ってしまう)ので必ず止める
  $('scouter-link').addEventListener('click', (e) => {
    e.preventDefault();
    toast('このボタンはクリックではなく、ブックマークバーへドラッグして使います', 'warn');
  });
  $('btn-scouter-copy').addEventListener('click', () => {
    const href = $('scouter-link').getAttribute('href');
    if (href && href !== '#') copyText(href);
  });
}
