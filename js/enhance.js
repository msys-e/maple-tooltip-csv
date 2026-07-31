// 強化プラン: ranking.csv(強化効率表)と取り込み装備を突き合わせ、
// 「次に強化すべきアクション」をメソ/スコア効率順に並べる
export const TABLE_LVS = [100, 150, 160, 200, 250];

export function nearestLv(lv) {
  if (!Number.isFinite(lv)) return null;
  let best = TABLE_LVS[0];
  for (const t of TABLE_LVS) if (Math.abs(t - lv) < Math.abs(best - lv)) best = t;
  return best;
}

// equip_type(チップ文字列) → 表の部位名。順序重要(Sub Weapon/EmblemをWeaponより先に)
const PART_MAP = [
  [/Mech\s*Heart/i, 'ハート'],
  [/Ring|Pendant|Face\s*Acc|Eye\s*Acc|Earring/i, 'アクセ(指輪等)'],
  [/Belt/i, 'ベルト'],
  [/Cape/i, 'マント'],
  [/Shoulder/i, '肩装飾'],
  [/Overall/i, '一体型'],
  [/\bTop\b/i, '上衣'],
  [/Bottom/i, '下衣'],
  [/Hat/i, '帽子'],
  [/Glove/i, '手袋'],
  [/Shoes/i, '靴'],
  [/Sub\s*Weapon/i, '補助武器'],
  [/Emblem/i, 'エンブレム'],
  [/Weapon/i, '武器'],
];

export function partOf(equipType) {
  if (!equipType) return null;
  for (const [re, part] of PART_MAP) if (re.test(equipType)) return part;
  return null;
}

// ranking.csv をパース(フィールドにカンマは含まれない前提)
export function parseRankingCSV(text) {
  const rows = [];
  for (const line of text.replace(/^﻿/, '').split(/\r?\n/).slice(1)) {
    if (!line.trim()) continue;
    const [rank, lv, item, setting, meso, score, mps, type] = line.split(',');
    const row = {
      rank: +rank, lv: +lv, item, setting,
      meso: +meso, score: +score, mps: +mps, type,
    };
    let m;
    if ((m = /^スタフォ\s*(\d+)→(\d+)★$/.exec(item))) {
      row.kind = 'star';
      row.s0 = +m[1];
      row.s1 = +m[2];
    } else if ((m = /^潜在\s*(.+?)\s*\/\s*(.+?)\s*←(.+)$/.exec(item))) {
      row.kind = 'pot';
      row.part = m[1];
      row.goal = m[2];
      row.from = m[3];
    }
    rows.push(row);
  }
  return rows;
}

// 潜在目標 → ライン種別と本数
function goalSpec(goal) {
  let m;
  if ((m = /^主ステ%(\d)ライン\(ALLステ%(含む|除く)\)$/.exec(goal))) {
    return { lineKind: m[2] === '含む' ? 'main_incl' : 'main_excl', n: +m[1] };
  }
  if ((m = /^攻撃%(\d)ライン$/.exec(goal))) return { lineKind: 'atk', n: +m[1] };
  if ((m = /^攻撃%orボス\s*(\d)ライン$/.exec(goal))) return { lineKind: 'atkboss', n: +m[1] };
  if ((m = /^クリダメ%(\d)ライン$/.exec(goal))) return { lineKind: 'crit', n: +m[1] };
  if (/^クリダメ%2ライン\+ステ%1ライン$/.test(goal)) return { lineKind: 'crit', n: 2, plusMain: 1 };
  return null;
}

function fromSpec(from) {
  let m;
  if ((m = /^(\d)ライン$/.exec(from))) return { lineKind: null, n: +m[1] }; // 目標と同種でN本
  if ((m = /^クリダメ(\d)ライン$/.exec(from))) return { lineKind: 'crit', n: +m[1] };
  return null;
}

// 装備の潜在ラインを種別ごとにカウント
export function countPotLines(item, lineKind, mainStat) {
  const atkName = mainStat === 'INT' ? 'Magic\\s*ATT' : 'Attack\\s*Power';
  const RES = {
    main_incl: new RegExp(`^(${mainStat}|All\\s*Stats)\\s*:?\\s*\\+\\d+%$`, 'i'),
    main_excl: new RegExp(`^${mainStat}\\s*:?\\s*\\+\\d+%$`, 'i'),
    atk: new RegExp(`^${atkName}\\s*:?\\s*\\+\\d+%$`, 'i'),
    atkboss: new RegExp(`^(${atkName}|Boss\\s*Damage)\\s*:?\\s*\\+\\d+%$`, 'i'),
    crit: /^Critical\s*Damage\s*:?\s*\+\d+%$/i,
  };
  const re = RES[lineKind];
  let n = 0;
  for (const k of [1, 2, 3]) {
    const t = (item[`pot${k}_text`] || '').replace(/I/g, 'l').replace(/^l/, 'I').trim();
    // I/l折り畳み対策: 素のtextでも判定
    if (re.test(item[`pot${k}_text`] || '') || re.test(t)) n++;
  }
  return n;
}

// 1装備×1行の適用可否
export function applicable(item, row, mainStat) {
  const lv = nearestLv(item.req_level_base ?? item.req_level);
  if (lv === null || lv !== row.lv) return false;
  if (row.kind === 'star') {
    if (item.no_starforce) return false;
    const s = Number(item.star_count);
    if (!Number.isFinite(s)) return false;
    return row.s0 === 0 ? s < 18 : s === row.s0;
  }
  if (row.kind === 'pot') {
    if (partOf(item.equip_type) !== row.part) return false;
    if (!item.potential_grade || /Can't/i.test(item.potential_grade)) return false;
    const goal = goalSpec(row.goal);
    const from = fromSpec(row.from);
    if (!goal || !from) return false;
    const kind = from.lineKind || goal.lineKind;
    const cur = countPotLines(item, kind, mainStat);
    if (cur !== from.n) return false;
    // 既に目標達成なら出さない
    const goalCur = countPotLines(item, goal.lineKind, mainStat);
    if (goalCur >= goal.n && !goal.plusMain) return false;
    if (goal.plusMain) {
      const mainCur = countPotLines(item, 'main_incl', mainStat);
      if (goalCur >= goal.n && mainCur >= goal.plusMain) return false;
    }
    return true;
  }
  return false;
}

// プラン構築: 全装備×全行の適用可能ペアを効率順に
export function buildPlan(items, table, mainStat) {
  const plan = [];
  for (const item of items) {
    for (const row of table) {
      if (applicable(item, row, mainStat)) plan.push({ item, row });
    }
  }
  plan.sort((a, b) => a.row.mps - b.row.mps);
  return plan;
}

// 対象外の理由(タブ下部の注記用)
export function excludeReason(item, table, mainStat) {
  const lv = nearestLv(item.req_level_base ?? item.req_level);
  if (lv === null) return '装備Lv不明';
  const part = partOf(item.equip_type);
  const hasStar = !item.no_starforce && Number.isFinite(Number(item.star_count));
  const hasPotRows = part && table.some((r) => r.kind === 'pot' && r.part === part);
  if (!hasStar && !hasPotRows) return `表に該当なし(${part ?? '部位不明'})`;
  return null;
}
