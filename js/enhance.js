// 強化プラン: ranking.csv(強化効率表)と取り込み装備を突き合わせ、
// 「次に強化すべきアクション」をメソ/スコア効率順に並べる
export const TABLE_LVS = [100, 150, 160, 200, 250];
export const CUBE_SALE_DISCOUNT = 0.25;

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
    const raw = (item[`pot${k}_text`] || '').trim();
    // OCRは大文字IをlとRead(同字形)するため行頭のみ復元(該当は"INT"のみ)
    if (re.test(raw) || re.test(raw.replace(/^l/, 'I'))) n++;
  }
  return n;
}

// 1装備×1行の段階判定
//   'next'   … 今すぐ実行できる(現状がその行の開始条件そのもの)
//   'future' … この装備で先々到達しうる(今の状態より先の段階)
//   null     … 適用不可(部位/Lv違い・通り過ぎた・目標達成済み)
export function planStep(item, row, mainStat) {
  const lv = nearestLv(item.req_level_base ?? item.req_level);
  if (lv === null || lv !== row.lv) return null;
  if (row.kind === 'star') {
    if (item.no_starforce) return null;
    // 空文字はNumber('')===0で★0に化けるため明示的に弾く(星認識失敗した装備への誤提案防止)
    if (item.star_count === '' || item.star_count === null || item.star_count === undefined) return null;
    const s = Number(item.star_count);
    if (!Number.isFinite(s)) return null;
    // 0→18★ の行は18★未満の装備の「今の一手」。それ以外は開始★が現状と一致すれば今、先なら将来
    if (row.s0 === 0) return s < 18 ? 'next' : null;
    if (s === row.s0) return 'next';
    return row.s0 > s ? 'future' : null;
  }
  if (row.kind === 'pot') {
    if (partOf(item.equip_type) !== row.part) return null;
    // 表のコストはレジェンダリー前提。未到達の装備は先にレジェ到達が必要なので対象外(注記で案内)
    if (!/Legendary/i.test(item.potential_grade || '')) return null;
    const goal = goalSpec(row.goal);
    const from = fromSpec(row.from);
    if (!goal || !from) return null;
    const kind = from.lineKind || goal.lineKind;
    const cur = countPotLines(item, kind, mainStat);
    if (cur > from.n) return null; // 開始条件を通り過ぎている
    // 既に目標達成なら出さない
    const goalCur = countPotLines(item, goal.lineKind, mainStat);
    if (goal.plusMain) {
      const mainCur = countPotLines(item, 'main_incl', mainStat);
      if (goalCur >= goal.n && mainCur >= goal.plusMain) return null;
    } else if (goalCur >= goal.n) {
      return null;
    }
    return cur === from.n ? 'next' : 'future';
  }
  return null;
}

// 1装備×1行の適用可否(今すぐ実行できる一手か)
export function applicable(item, row, mainStat) {
  return planStep(item, row, mainStat) === 'next';
}

// 表の元値を保ったまま、表示・並べ替えに使う実効コストを返す。
// キューブセールは潜在行だけが対象で、スターフォース行には適用しない。
export function effectivePlanCost(row, { cubeSale = false } = {}) {
  const discounted = cubeSale && row.kind === 'pot' && /キューブ/.test(row.setting || '');
  const multiplier = discounted ? 1 - CUBE_SALE_DISCOUNT : 1;
  const meso = row.meso * multiplier;
  // ranking.csv の mps は小数2桁へ丸め済み。割引時は二重丸めを避けるため
  // 割引後メソとスコアから再計算する。
  const mps = discounted && Number.isFinite(row.score) && row.score > 0
    ? meso * 1000 / row.score
    : row.mps;
  return {
    meso,
    mps,
    discounted,
  };
}

// 設定名だけが異なる同一結果を、設定の差を残したまま1アクションへまとめる。
// "1144 / モード4" と "4444 / モード4" のように共通の補足がある場合は、
// 差分だけを "1144 / 4444（同一結果）" と表示する。
function equivalentSettingLabel(settings) {
  if (settings.length <= 1) return settings[0] || '';
  const parts = settings.map((setting) => String(setting ?? '').split(/\s*\/\s*/));
  const suffix = parts[0].slice(1).join(' / ');
  const hasCommonSuffix = suffix.length > 0 &&
    parts.every((part) => part.length > 1 && part.slice(1).join(' / ') === suffix);
  const labels = hasCommonSuffix ? parts.map((part) => part[0]) : settings;
  return `${labels.join(' / ')}（同一結果）`;
}

function samePlanResult(a, b) {
  return a.immediate === b.immediate &&
    a.discounted === b.discounted &&
    a.row.item === b.row.item &&
    a.meso === b.meso &&
    a.row.score === b.row.score &&
    a.mps === b.mps;
}

// プラン構築: 全装備×全行の適用可能ペアを実効コスト順に
// includeFuture=true で「今の一手」だけでなく、その装備で先々到達しうる段階も全て出す
export function buildPlan(items, table, mainStat, { includeFuture = false, cubeSale = false } = {}) {
  const plan = [];
  for (const item of items) {
    const itemPlan = [];
    for (const row of table) {
      const step = planStep(item, row, mainStat);
      if (step === 'next' || (includeFuture && step === 'future')) {
        const entry = {
          item,
          row,
          immediate: step === 'next',
          equivalentSettings: [row.setting],
          ...effectivePlanCost(row, { cubeSale }),
        };
        const equivalent = itemPlan.find((candidate) => samePlanResult(candidate, entry));
        if (!equivalent) {
          itemPlan.push(entry);
          continue;
        }
        if (!equivalent.equivalentSettings.includes(row.setting)) {
          equivalent.equivalentSettings.push(row.setting);
        }
        equivalent.row = {
          ...equivalent.row,
          setting: equivalentSettingLabel(equivalent.equivalentSettings),
        };
      }
    }
    plan.push(...itemPlan);
  }
  plan.sort((a, b) => a.mps - b.mps);
  return plan;
}

// 対象外の理由(タブ下部の注記用)。適用行が1つもない装備に呼ぶ
export function excludeReason(item, table, mainStat) {
  const lv = nearestLv(item.req_level_base ?? item.req_level);
  if (lv === null) return '装備Lv不明(再取り込みが必要)';
  const part = partOf(item.equip_type);
  if (part && table.some((r) => r.kind === 'pot' && r.part === part) &&
      !/Legendary/i.test(item.potential_grade || '')) {
    return `潜在等級がレジェンダリー未達(${item.potential_grade || '不明'})`;
  }
  return '適用可能な行なし(目標達成済み or 表に該当Lv/部位の行なし)';
}
