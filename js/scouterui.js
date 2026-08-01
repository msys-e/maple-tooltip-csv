// スカウター連携タブのDOM層(app.js肥大回避のため分離)
import { SCOUTER_FIELDS, GROUP_LABELS, SLOTS, buildDiff, buildBookmarklet } from './scouter.js';
import { findStatWindow, findStatPopup } from './detectstat.js';
import { parseStatWindow, parseStatPopup } from './parsestat.js';
import * as store from './store.js';

const $ = (id) => document.getElementById(id);

let toast = () => {};
let copyText = () => {};
let chime = () => {};
let cap = null;            // app.js から注入されるキャプチャ操作
let recognizeRegion = null; // (img, bbox) => { rec, canvas }
let reportUnknowns = null;  // (rec, canvas) => void  未知グリフをラベラーへ
let form = { slot: '1', values: {} };

// 取り込みステップ。STATウィンドウ1枚 → ステータス3種のホバーポップアップ
const STEPS = [
  { id: 'stat', name: 'STATウィンドウ', detector: findStatWindow },
  { id: 'mainStat', name: 'メインステータス', detector: findStatPopup },
  { id: 'subStat', name: 'サブステータス', detector: findStatPopup },
  { id: 'atk', name: '攻撃力/魔力', detector: findStatPopup },
];
let stepIdx = -1; // -1 = 取り込みしていない

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

// ---------- OCR取り込み ----------
function renderSteps() {
  const active = stepIdx >= 0;
  $('scouter-steps').style.display = active ? 'block' : 'none';
  $('scouter-ocr-hint').style.display = active ? 'block' : 'none';
  $('btn-scouter-skip').style.display = active ? '' : 'none';
  $('btn-scouter-stop').style.display = active ? '' : 'none';
  $('btn-scouter-ocr').disabled = active;
  $('scouter-ocr-status').textContent = active
    ? `読み取り中 (${stepIdx + 1}/${STEPS.length}: ${STEPS[stepIdx].name})`
    : '停止中';
  for (const li of $('scouter-steps').children) {
    const i = STEPS.findIndex((s) => s.id === li.dataset.step);
    li.classList.toggle('current', i === stepIdx);
    li.classList.toggle('done', stepIdx >= 0 && i < stepIdx);
  }
}

function applyStep() {
  // 検出対象が変わるので processed もリセットされる(setDetector 側で実施)
  cap.setDetector(STEPS[stepIdx].detector);
  renderSteps();
}

function nextStep() {
  stepIdx++;
  if (stepIdx >= STEPS.length) {
    stopOcr();
    toast('取り込みが完了しました。値を確認して「ブックマークレットを生成」してください');
    return;
  }
  applyStep();
}

function stopOcr({ quiet = false } = {}) {
  if (stepIdx < 0) return;
  stepIdx = -1;
  cap.setDetector(null); // 装備ツールチップ検出に戻す
  cap.onFrame(null);
  renderSteps();
  if (!quiet) toast('読み取りを終了しました', 'warn');
}

// 入力欄へ流し込む。ユーザーが後から直せるよう、確定はしない(フォームを埋めるだけ)
function fillForm(values) {
  let n = 0;
  for (const [key, v] of Object.entries(values)) {
    const el = $(inputId(key));
    if (!el) continue;
    el.value = String(v);
    el.classList.add('filled');
    n++;
  }
  persist();
  return n;
}

// CaptureController から安定フレームごとに呼ばれる。
// 戻り値 'lowq' は「処理済みにせず次フレームで再試行」の意(既存の装備取り込みと同じ約束)
function handleFrame(img, bbox) {
  const step = STEPS[stepIdx];
  const { rec, canvas } = recognizeRegion(img, bbox);
  const res = step.id === 'stat' ? parseStatWindow(rec) : parseStatPopup(rec, step.id);
  const n = Object.keys(res.values).length;
  if (!n) {
    // 未知グリフだらけ = フォント差。ラベラーに積んで学習させる
    if (rec.some((l) => l.unknowns?.length)) reportUnknowns?.(rec, canvas);
    return 'lowq';
  }
  const filled = fillForm(res.values);
  chime('success');
  toast(`${step.name}: ${filled}項目を読み取りました`);
  nextStep();
  return 'ok';
}

async function startOcr() {
  if (!cap || !recognizeRegion) { toast('この環境では画面共有が使えません', 'err'); return; }
  if (!cap.running()) {
    try {
      await cap.start();
    } catch {
      toast('画面共有がキャンセルされました', 'warn');
      return;
    }
  }
  cap.onFrame(handleFrame);
  stepIdx = 0;
  applyStep();
  toast('STATウィンドウを開いてください');
}

export function initScouterUI(deps = {}) {
  if (deps.toast) toast = deps.toast;
  if (deps.copyText) copyText = deps.copyText;
  if (deps.chime) chime = deps.chime;
  cap = deps.capture || null;
  recognizeRegion = deps.recognizeRegion || null;
  reportUnknowns = deps.reportUnknowns || null;

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

  $('btn-scouter-ocr').addEventListener('click', startOcr);
  $('btn-scouter-skip').addEventListener('click', () => {
    toast(`${STEPS[stepIdx].name} をスキップしました(手入力してください)`, 'warn');
    nextStep();
  });
  $('btn-scouter-stop').addEventListener('click', () => stopOcr());
  // 他タブへ移ったら装備ツールチップ検出に戻す(戻し忘れで装備取り込みが死ぬのを防ぐ)
  for (const btn of document.querySelectorAll('.tab-btn')) {
    btn.addEventListener('click', () => {
      if (btn.dataset.tab !== 'scouter' && stepIdx >= 0) {
        stopOcr({ quiet: true });
        toast('タブを移動したため読み取りを終了しました', 'warn');
      }
    });
  }
  renderSteps();
}
