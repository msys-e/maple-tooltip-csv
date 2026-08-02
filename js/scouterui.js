// スカウター連携タブのDOM層(app.js肥大回避のため分離)
import { SCOUTER_FIELDS, GROUP_LABELS, SLOTS, buildDiff, buildBookmarklet } from './scouter.js';
import { findStatWindow, findStatPopup, findLevelBadge } from './detectstat.js';
import { parseStatWindow, parseStatPopup, parseLevel } from './parsestat.js';
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
  // ★フレームの委譲を最優先で外す。ここで例外が出て委譲が残ると、
  //   装備タブに戻っても全フレームがこちらへ流れ続けて取り込みが死ぬ
  try { cap.onFrame(null); } catch { /* 注入側の不整合は握りつぶす */ }
  try { cap.setDetector(null); } catch { /* 装備ツールチップ検出への復帰に失敗しても停止は続行 */ }
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

function resetForCharacterSwitch() {
  stopOcr({ quiet: true });
  form = store.loadScouter();
  if (!form || typeof form !== 'object') form = { slot: '1', values: {} };
  if (!SLOTS.includes(String(form.slot))) form.slot = '1';
  if (!form.values || typeof form.values !== 'object') form.values = {};
  renderForm();
  $('scouter-slot').value = form.slot;
  updateSlotLabels(form.slot);
  $('scouter-out').style.display = 'none';
  renderSteps();
}

// CaptureController から安定フレームごとに呼ばれる。
// 戻り値 'lowq' は「処理済みにせず次フレームで再試行」の意(既存の装備取り込みと同じ約束)
// レベルはSTATウィンドウではなく CHARACTER INFO の「Lv. NNN」バッジにあるので、
// STATウィンドウを撮った同じフレームからついでに読む。
// そのウィンドウが閉じていても取り込みは止めない(レベルだけ手入力のまま)
function readLevel(img) {
  try {
    const bbox = findLevelBadge(img);
    if (bbox.error) return {};
    const { rec, canvas } = recognizeRegion(img, bbox);
    const { values } = parseLevel(rec);
    // 桁ごとにグリフが必要なので、未知の数字はラベラーに積んで次回から読めるようにする
    if (!Object.keys(values).length && rec.some((l) => l.unknowns?.length)) reportUnknowns?.(rec, canvas);
    return values;
  } catch {
    return {}; // レベルの取得失敗で取り込み全体を落とさない
  }
}

function handleFrame(img, bbox) {
  const step = STEPS[stepIdx];
  if (!step) return 'error'; // 停止済みなのに委譲が残っている(異常)。処理済みにはしない
  try {
    const { rec, canvas } = recognizeRegion(img, bbox);
    const res = step.id === 'stat' ? parseStatWindow(rec) : parseStatPopup(rec, step.id);
    if (step.id === 'stat') Object.assign(res.values, readLevel(img));
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
  } catch (e) {
    // 毎フレーム呼ばれる経路なので、例外を投げっぱなしにすると
    // エラーを撒き続けたうえ装備タブの取り込みまで巻き込んで壊す
    console.error('[mtc] STAT取り込みでエラー', e);
    stopOcr({ quiet: true });
    toast('読み取り中にエラーが発生したため停止しました', 'err');
    return 'error';
  }
}

async function startOcr() {
  if (!cap || !recognizeRegion) { toast('この環境では画面共有が使えません', 'err'); return; }
  // 古いキャッシュのJSが混ざると setDetector が無い状態で動き出し、
  // 途中で例外 → 委譲が外れず装備タブまで壊れる。事前に弾く
  if (!cap.supported) {
    toast('ページを再読み込みしてください(Ctrl+Shift+R)。古いスクリプトが読み込まれています', 'err');
    return;
  }
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

  $('scouter-form').addEventListener('input', (e) => {
    // 手で書き換えたらOCR由来の印は外す(色は「OCRが入れた値」の意味なので)
    if (e.target?.dataset?.key) e.target.classList.remove('filled');
    persist();
  });
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
      if (!el) continue;
      el.value = '';
      el.classList.remove('filled'); // OCRで入れた印も消す(空欄なのに色が残ると誤解する)
    }
    persist();
    $('scouter-out').style.display = 'none';
    toast('入力をクリアしました', 'warn');
  });

  // ドラッグ内容を明示する。既定でも <a href> から入るが、
  // 環境によって取りこぼすことがあるので念のため両方の型で渡す
  $('scouter-link').addEventListener('dragstart', (e) => {
    const href = $('scouter-link').getAttribute('href');
    if (!href || href === '#' || !e.dataTransfer) return;
    e.dataTransfer.setData('text/uri-list', href);
    e.dataTransfer.setData('text/plain', href);
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
  return { resetForCharacterSwitch };
}
