// 認識済み行 → アイテムレコード
// ステータス内訳: 合計 +N (base +star +bonus)
//   base=白(素値) star=黄(スターフォース) bonus=水色(転生)

const STAT_LABELS = [
  ['Attack Power', 'attack_power'],
  ['Magic ATT', 'magic_att'],
  ['All Stats', 'all_stats'],
  ['Max HP', 'max_hp'],
  ['Max MP', 'max_mp'],
  ['Boss Damage', 'boss_damage'],
  ['Damage', 'damage'],
  ['Enemy DEF Ignored', 'ignore_def'],
  ['Ignore Enemy DEF', 'ignore_def'],
  ['Defense', 'defense'],
  ['STR', 'str'],
  ['DEX', 'dex'],
  ['INT', 'int'],
  ['LUK', 'luk'],
];

const GRADE_BY_BULLET = { green: 'Legendary', yellow: 'Unique', purple: 'Epic' };

const STAT_RE = new RegExp(
  // OCRの癖への耐性: I/l同字形は[Il]で受け、語間スペースは0個以上でも可
  `^(${STAT_LABELS.map(([l]) =>
    l.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/I/g, '[Il]').replace(/ /g, '\\s*')
  ).join('|')})` +
  `\\s*\\+([0-9,]+)(%?)(?:\\s*\\((.*)\\))?$`
);

function num(s) {
  return parseInt(String(s).replace(/[,%]/g, ''), 10);
}

// 括弧内をトークン分割し、文字色で base/star/bonus に振り分ける
function parseBreakdown(chars, parenOpenIdx) {
  const tokens = [];
  let cur = null;
  for (let i = parenOpenIdx + 1; i < chars.length; i++) {
    const c = chars[i];
    if (c.ch === ')') break;
    if (c.ch === ' ') { cur = null; continue; }
    if (!cur) { cur = { text: '', colors: {} }; tokens.push(cur); }
    cur.text += c.ch;
    if (/[0-9]/.test(c.ch)) cur.colors[c.color] = (cur.colors[c.color] || 0) + 1;
  }
  const out = { base: null, star: null, bonus: null };
  for (const t of tokens) {
    if (!/[0-9]/.test(t.text)) continue;
    const color = Object.entries(t.colors).sort((a, b) => b[1] - a[1])[0]?.[0] || 'white';
    const v = num(t.text);
    if (!t.text.startsWith('+') && out.base === null) out.base = v;
    else if (color === 'yellow') out.star = (out.star ?? 0) + v;
    else if (color === 'cyan') out.bonus = (out.bonus ?? 0) + v;
    else if (out.star === null) out.star = v;   // 色不明時のフォールバック(2番目=スタフォ)
    else out.bonus = (out.bonus ?? 0) + v;
  }
  return out;
}

// lines: recognizeLines() の出力(text/chars/bullet/unknowns付き)
export function parseTooltip(lines, starCount) {
  const item = {
    timestamp: new Date().toISOString(),
    item_name: '',
    star_count: starCount ?? '',
    potential_grade: '',
    extra_lines: [],
    raw_text: lines.map((l) => (l.bullet ? `[${l.bullet}] ` : '') + l.text).join('\n'),
  };
  let section = 'header';
  let potIdx = 0;
  const consumed = new Set();

  const textLines = lines.filter((l) => !l.isStars && l.text.trim().length > 0);
  // アイテム名 = 定型キーワード行(Untradable/Currently Equipped/Required Job)の直前の行。
  // 検出上端が行き過ぎてツールチップ外のジャンク行が先頭に混ざっても名前を取り違えない
  const kw = /^(Untradable|Currently\s*Equ|Required\s*(Job|Level)|Special\s*Item)/i;
  const kwIdx = textLines.findIndex((l) => kw.test(l.text.trim()));
  const nameLine = kwIdx > 0 ? textLines[kwIdx - 1] : (kwIdx === -1 && textLines.length ? textLines[0] : null);
  item._name_y = nameLine ? nameLine.y0 : -1; // 内部用: 名前行より上=ジャンク領域の境界
  if (nameLine) {
    item.item_name = nameLine.text.trim();
    consumed.add(nameLine);
    // 名前より上のジャンク行はステータス解釈の対象外にする
    for (let i = 0; i < textLines.indexOf(nameLine); i++) consumed.add(textLines[i]);
  }

  // 星数: 名前の直上~90px以内の星列のみ数える(それより上のはインベントリ等の誤検知)
  const starGlyphs = lines
    .filter((l) => l.isStars && (!nameLine || (l.y1 <= nameLine.y0 && l.y1 >= nameLine.y0 - 90)))
    .reduce((s, l) => s + l.glyphs.length, 0);
  // 名前行が特定できたなら星は必ずisStars行由来(無ければ星0)。
  // バンド由来のフォールバック値は文字を星と誤認し得るため名前不明時のみ使う
  if (nameLine) item.star_count = starGlyphs;
  else if (starGlyphs > 0) item.star_count = starGlyphs;

  for (const ln of textLines) {
    if (consumed.has(ln)) continue;
    const text = ln.text.trim();

    // 例: "Potential : Legendary" / "Potential : Epic (Fully Enhanced)" → 等級のみ取る
    // 先頭の"L "はポテンシャルアイコンを'L'と誤ラベルした場合の救済
    const potHead = /^(?:L\s+)?Potential\s*:?\s*([^(]*?)\s*(?:\(.*)?$/.exec(text);
    if (potHead) {
      if (potHead[1].trim()) item.potential_grade = potHead[1].trim(); // 等級欠落行でも空文字で上書きしない
      section = 'potential';
      continue;
    }
    if (/^Soul\s*:/.test(text) || /^Exceptional\s*:/.test(text)) {
      section = 'after';
      item.extra_lines.push(text);
      continue;
    }

    if (ln.bullet) {
      const grade = GRADE_BY_BULLET[ln.bullet] || ln.bullet;
      if (section === 'potential' && potIdx < 3) {
        potIdx++;
        item[`pot${potIdx}_text`] = text;
        item[`pot${potIdx}_grade`] = grade;
      } else {
        item.extra_lines.push(`[${grade}] ${text}`);
      }
      continue;
    }

    if (section !== 'potential' && section !== 'after') {
      const m = STAT_RE.exec(text);
      if (m) {
        const label = m[1];
        const pct = m[3] === '%';
        const foldL = (s) => s.replace(/I/g, 'l').replace(/\s+/g, '');
        const def = STAT_LABELS.find(([l]) => foldL(l) === foldL(label));
        let base = def[1];
        if (pct && !base.endsWith('_pct')) base += '_pct';
        if (item[`${base}_total`] === undefined) {
          item[`${base}_total`] = num(m[2]);
          if (m[4] !== undefined) {
            const parenIdx = ln.chars.findIndex((c) => c.ch === '(');
            const bd = parseBreakdown(ln.chars, parenIdx);
            if (bd.base !== null) item[`${base}_base`] = bd.base;
            if (bd.star !== null) item[`${base}_star`] = bd.star;
            if (bd.bonus !== null) item[`${base}_bonus`] = bd.bonus;
          }
          continue;
        }
      }
    }
    // どの構造にも該当しない行
    if (section === 'potential' || section === 'after') item.extra_lines.push(text);
  }
  return item;
}
