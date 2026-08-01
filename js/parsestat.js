// STATウィンドウ / ステータス詳細ポップアップの認識行 → maplescouterのキー
//
// parse.js の STAT_LABELS 方式を踏襲。ただし装備ツールチップと違い
// 「ラベル 値」が1行に並ぶ(値が次行に回ることもある)ので、行をまたいだ値探索を許す。
//
// ★ラベル文字列はGMS英語クライアントの実画面で要確認。表記ゆれは labels に足すだけで済むよう
//   別名の配列にしてある(例: ARCANE FORCE / ARCANE POWER)。

// key は scouter.js の SCOUTER_FIELDS と同じ = maplescouter の stat キー名
export const STAT_LABELS = [
  { key: 'bossDmg', labels: ['BOSS DAMAGE', 'DAMAGE TO BOSSES'] },
  { key: 'normalDmg', labels: ['NORMAL MONSTER DAMAGE', 'DAMAGE TO NORMAL MONSTERS'] },
  { key: 'ignoreDef', labels: ['IGNORE DEFENSE', 'IGNORE DEF', 'IGNORE ENEMY DEFENSE', 'DEFENSE IGNORED'] },
  { key: 'criticalDmg', labels: ['CRITICAL DAMAGE'] },
  { key: 'critical', labels: ['CRITICAL RATE', 'CRITICAL CHANCE'] },
  { key: 'buffDuration', labels: ['BUFF DURATION'] },
  { key: 'ignoreElementalResist', labels: ['IGNORE ELEMENTAL RESISTANCE', 'ELEMENTAL RESISTANCE IGNORED'] },
  { key: 'statusAdditionalDmg', labels: ['ABNORMAL STATUS ADDITIONAL DAMAGE', 'ABNORMAL STATUS DAMAGE', 'STATUS DAMAGE'] },
  { key: 'summonPersistTime', labels: ['SUMMON DURATION', 'SUMMONS DURATION INCREASE'] },
  { key: 'resetCoolDown', labels: ['COOLDOWN RESET', 'COOLDOWN RESET CHANCE'] },
  { key: 'arcaneForce', labels: ['ARCANE FORCE', 'ARCANE POWER'] },
  { key: 'authenticForce', labels: ['AUTHENTIC FORCE', 'SACRED FORCE', 'SACRED POWER'] },
  // 最後: 短いラベルは長いラベル(BOSS DAMAGE等)に食われないよう必ず後ろへ
  { key: 'dmg', labels: ['DAMAGE'] },
];

// 「COOLDOWN REDUCTION  -2 sec, -5%」のように1行から2値取れる特殊行
const COOLDOWN_LABELS = ['COOLDOWN REDUCTION', 'COOLDOWN'];

// ラベル照合用の正規化: 英字だけに落とす(数値・記号・空白は落とす)。
// OCRは大文字Iを小文字lと同字形で読む(parse.js と同じ慣用句)ので I→l に寄せてから
// 大文字化する = I と L はどちらも L に潰れて揺れを吸収できる。
// 数値は正規化前の生テキストから拾う(ここで '.' や '-' を落とすと 12.5 が 125 になるため)
export function norm(s) {
  return String(s).replace(/I/g, 'l').toUpperCase().replace(/[^A-Z]/g, '');
}

// 行から数値を拾う。'1,234' '12.5%' '-3' に対応。pct=true の要素は%付き
export function numbersIn(text) {
  const out = [];
  for (const m of String(text).matchAll(/(-?[\d,]+(?:\.\d+)?)\s*(%?)/g)) {
    const raw = m[1].replace(/,/g, '');
    if (raw === '' || raw === '-') continue;
    const v = Number(raw);
    if (Number.isFinite(v)) out.push({ value: v, pct: m[2] === '%' });
  }
  return out;
}

// ラベル表を「正規化済みラベルが長い順」に展開しておく(部分一致の食い合い防止)
const ENTRIES = STAT_LABELS
  .flatMap(({ key, labels }) => labels.map((l) => ({ key, label: l, n: norm(l) })))
  .sort((a, b) => b.n.length - a.n.length);
const COOLDOWN_NORMS = COOLDOWN_LABELS.map(norm).sort((a, b) => b.length - a.length);

const textOf = (ln) => (typeof ln === 'string' ? ln : (ln?.text ?? ''));

// lines: recognizeLines() の出力 or 素の文字列配列
// 戻り: { values: {key: number}, unknownLines: [text] }
//   値が見つからなかったラベル行は values に入れない(= フォームを空欄のままにする)
export function parseStatWindow(lines) {
  const texts = lines.map(textOf);
  const norms = texts.map(norm);
  const values = {};
  const matched = new Set();

  for (let i = 0; i < texts.length; i++) {
    const n = norms[i];
    if (!n) continue;

    // クールタイム減少: 「-2 sec / -5%」を1行から2値に分解する
    if (COOLDOWN_NORMS.some((c) => n.startsWith(c))) {
      const sec = /(-?[\d.]+)\s*sec/i.exec(texts[i]);
      const pct = /(-?[\d.]+)\s*%/.exec(texts[i]);
      if (sec) values.coolTimeReduce = Math.abs(Number(sec[1]));
      if (pct) values.coolTimeReducePercent = Math.abs(Number(pct[1]));
      if (sec || pct) { matched.add(i); continue; }
    }

    const hit = ENTRIES.find((e) => n.startsWith(e.n));
    if (!hit || values[hit.key] !== undefined) continue;
    // 値は同じ行にあるのが基本。無ければ次行(ラベルと値が2行に分かれるレイアウト)を見る。
    // ただし次行が別のラベル行ならそれは値ではない
    let nums = numbersIn(texts[i]);
    if (!nums.length && i + 1 < texts.length && !ENTRIES.some((e) => norms[i + 1].startsWith(e.n))) {
      nums = numbersIn(texts[i + 1]);
      if (nums.length) matched.add(i + 1);
    }
    if (!nums.length) continue;
    values[hit.key] = nums[0].value; // 「85% (+15%)」のような内訳付きは先頭が現在値
    matched.add(i);
  }

  const unknownLines = texts.filter((t, i) => !matched.has(i) && t.trim() !== '');
  return { values, unknownLines };
}

// ステータスのオンマウスで出る内訳ポップアップ。
// 「素値 / 増加率% / 固定加算」の3値を、出現順(%付きが増加率、残りは先頭から素→固定)で拾う。
// ★暫定ルール: 実ポップアップの行構成は未確認(フィクスチャ採取後に要調整)。
//   誤りがあってもフォームは編集可能なので、ユーザーが直せる範囲に留める設計。
// target: 'mainStat' | 'subStat' | 'atk' — どのステータスにホバー中かは呼び出し側(UIのステップ)が決める
export function parseStatPopup(lines, target) {
  const prefix = { mainStat: 'mainStat', subStat: 'subStat', atk: 'atk' }[target];
  if (!prefix) return { values: {}, unknownLines: [] };
  // 攻撃力だけキー名が base/Percent/Abs と不揃い(maplescouter側の命名)
  const keys = prefix === 'atk'
    ? ['atkBase', 'atkPercent', 'atkAbs']
    : [`${prefix}Base`, `${prefix}Per`, `${prefix}Abs`];

  const nums = lines.flatMap((ln) => numbersIn(textOf(ln)));
  const values = {};
  const pct = nums.find((x) => x.pct);
  const plain = nums.filter((x) => !x.pct);
  if (plain[0]) values[keys[0]] = plain[0].value;
  if (pct) values[keys[1]] = pct.value;
  if (plain[1]) values[keys[2]] = plain[1].value;
  const unknownLines = nums.length ? [] : lines.map(textOf).filter((t) => t.trim() !== '');
  return { values, unknownLines };
}
