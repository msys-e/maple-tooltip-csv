// STATウィンドウ / ステータス詳細ポップアップの認識行 → maplescouterのキー
//
// 実画面(GMS英語クライアント)のレイアウト:
//   STATウィンドウは2カラム。1行に「左ラベル 左値  右ラベル 右値」が並ぶため、
//   1行1ラベルではなく「行の中の全ラベル出現」を拾い、各ラベルの直後から
//   次のラベル手前までを値の範囲として切り出す。
//     例: "IGNORE DEFENSE 96.85% NORMAL ENEMY DAMAGE 12.00%"
//   ポップアップは [Applied Value] 直後の "Base Value : N" / "% Value : M%" の2行。

// 取り込む対象。key は scouter.js の SCOUTER_FIELDS と同じ = maplescouter の stat キー名
export const STAT_LABELS = [
  { key: 'dmg', label: 'DAMAGE' },
  { key: 'bossDmg', label: 'BOSS DAMAGE' },
  { key: 'normalDmg', label: 'NORMAL ENEMY DAMAGE' },
  { key: 'ignoreDef', label: 'IGNORE DEFENSE' },
  { key: 'critical', label: 'CRITICAL RATE' },
  { key: 'criticalDmg', label: 'CRITICAL DAMAGE' },
  { key: 'buffDuration', label: 'BUFF DURATION' },
  { key: 'ignoreElementalResist', label: 'IGNORE ELEMENTAL RESISTANCE' },
  { key: 'statusAdditionalDmg', label: 'ADDITIONAL STATUS DAMAGE' },
  { key: 'summonPersistTime', label: 'SUMMONS DURATION INCREASE' },
  { key: 'resetCoolDown', label: 'COOLDOWN NOT APPLIED' },
  { key: 'arcaneForce', label: 'ARCANE POWER' },
  { key: 'authenticForce', label: 'SACRED POWER' },
];

// 「COOLDOWN REDUCTION  4 sec / 5%」だけは1行から2値を取る
const COOLDOWN_LABEL = 'COOLDOWN REDUCTION';

// 取り込まないが「ここにラベルがある」と知っておく必要があるもの。
// 知らないと直前のラベルの値の範囲がこの行末まで伸び、隣の列の数字を拾ってしまう
const IGNORED_LABELS = [
  'DAMAGE RANGE', 'FINAL DAMAGE', 'ATTACK POWER', 'MAGIC ATT',
  'MESOS OBTAINED', 'ITEM DROP RATE', 'ADDITIONAL EXP OBTAINED', 'STAR FORCE',
  'COMBAT POWER', 'HYPER STATS', 'ABILITY',
];

// ラベル照合用の正規化: 英字だけに落とす。OCRは大文字Iを小文字lと同字形で読む
// (parse.js と同じ慣用句)ので I→l に寄せてから大文字化し、I と L を同一視する。
// 数値は正規化前の生テキストから拾う('.' や '-' を落とすと 12.5 が 125 になるため)
export function norm(s) {
  return String(s).replace(/I/g, 'l').toUpperCase().replace(/[^A-Z]/g, '');
}

// 行から数値を拾う。'1,234' '12.5%' '-3' に対応。pct=true は%付き
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

const ALL_LABELS = [
  ...STAT_LABELS.map((e) => e.label),
  COOLDOWN_LABEL,
  ...IGNORED_LABELS,
];
const KEY_BY_NORM = new Map(STAT_LABELS.map((e) => [norm(e.label), e.key]));
const COOLDOWN_NORM = norm(COOLDOWN_LABEL);

// 長いラベルを先に置く = 'DAMAGE RANGE' が 'DAMAGE' に食われない
// (正規表現の選択肢は左から試されるため、この並び順自体が優先順位になる)
const LABEL_RE = new RegExp(
  `(${[...ALL_LABELS].sort((a, b) => b.length - a.length)
    .map((l) => l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/I/g, '[Il]').replace(/ /g, '\\s*'))
    .join('|')})`,
  'gi',
);

const textOf = (ln) => (typeof ln === 'string' ? ln : (ln?.text ?? ''));

// lines: recognizeLines() の出力 or 素の文字列配列
// 戻り: { values: {key: number}, unknownLines: [text] }
//   値が取れなかったキーは values に入れない(= フォームを空欄のままにする)
export function parseStatWindow(lines) {
  const values = {};
  const unknownLines = [];

  for (const ln of lines) {
    const text = textOf(ln);
    if (!text.trim()) continue;
    const hits = [...text.matchAll(LABEL_RE)];
    if (!hits.length) { unknownLines.push(text); continue; }

    hits.forEach((m, i) => {
      // 値の範囲 = このラベルの直後 〜 次のラベルの手前(なければ行末)
      const from = m.index + m[0].length;
      const to = i + 1 < hits.length ? hits[i + 1].index : text.length;
      const seg = text.slice(from, to);
      const n = norm(m[0]);

      if (n === COOLDOWN_NORM) {
        const sec = /(-?[\d.]+)\s*sec/i.exec(seg);
        const pct = /(-?[\d.]+)\s*%/.exec(seg);
        if (sec && values.coolTimeReduce === undefined) values.coolTimeReduce = Math.abs(Number(sec[1]));
        if (pct && values.coolTimeReducePercent === undefined) values.coolTimeReducePercent = Math.abs(Number(pct[1]));
        return;
      }
      const key = KEY_BY_NORM.get(n);
      if (!key || values[key] !== undefined) return; // 無視ラベル / 取得済み
      const nums = numbersIn(seg);
      if (nums.length) values[key] = nums[0].value;
    });
  }
  return { values, unknownLines };
}

// ステータスのオンマウスで出るポップアップの [Applied Value] 部分。
//   Base Value : 2546   → *Base
//   % Value : 5%        → *Per / atkPercent
// 固定加算(*Abs)に相当する行はこのUIには無いため触らない(手入力のまま)。
// target: 'mainStat' | 'subStat' | 'atk' — どのステータスにホバー中かは呼び出し側(UIのステップ)が決める
export function parseStatPopup(lines, target) {
  const keys = {
    mainStat: ['mainStatBase', 'mainStatPer'],
    subStat: ['subStatBase', 'subStatPer'],
    atk: ['atkBase', 'atkPercent'],
  }[target];
  if (!keys) return { values: {}, unknownLines: [] };

  const values = {};
  const unknownLines = [];
  for (const ln of lines) {
    const text = textOf(ln);
    if (!text.trim()) continue;
    const nums = numbersIn(text);
    // 「% Value」の判定を先に(「Base Value」より特徴的な行頭の%で見分ける)
    if (/%\s*Value/i.test(text)) {
      if (nums.length) values[keys[1]] = nums[0].value;
    } else if (/Base\s*Va[lI]ue/i.test(text)) {
      if (nums.length) values[keys[0]] = nums[0].value;
    } else {
      unknownLines.push(text);
    }
  }
  return { values, unknownLines };
}
