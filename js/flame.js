// 転生(追加オプション)スコアと、公式確率表からの動的パーセンタイル計算。
// 非武器のみを対象にする。武器は基礎攻撃力が必要なため別判定とする。

const SCORE_SCALE = 1000;
const MAX_WEIGHT = 1_000_000;
const SETTINGS_VERSION = 2;
const STAT_NAMES = ['STR', 'DEX', 'INT', 'LUK'];
export const DEFAULT_SECONDARY = { STR: 'DEX', DEX: 'STR', INT: 'LUK', LUK: 'DEX' };
const DUAL_STATS = [
  ['STR', 'DEX'], ['STR', 'INT'], ['STR', 'LUK'],
  ['DEX', 'INT'], ['DEX', 'LUK'], ['INT', 'LUK'],
];

const ADVANTAGED_NAME_PATTERNS = [
  /\bRoyal (?:Warrior Helm|Dunwitch Hat|Ranger Beret|Assassin Hood|Wanderer Hat)\b/i,
  /\bEagle Eye (?:Warrior Armor|Dunwitch Robe|Ranger Cowl|Assassin Shirt|Wanderer Coat)\b/i,
  /\bTrixter (?:Warrior|Dunwitch|Ranger|Assassin|Wanderer) Pants\b/i,
  /\bArcane Umbra\b/i,
  /\bEternal\b/i,
  /\bGenesis\b/i,
  /\bBerserked\b/i,
  /\bMagic Eyepatch\b/i,
  /\bSource of Suffering\b/i,
  /\bCommanding Force Earring\b/i,
  /\bDreamy Belt\b/i,
  /\bCursed\b.*\bSpellbook\b/i,
  /\bDaybreak Pendant\b/i,
  /\bOriginal Sin of Pride\b/i,
  /\bOath of Death\b/i,
];

const EXCLUDED_TYPE = /\bRing\b|Mech\s*Heart|Android\s*Heart|Badge|Emblem|Medal|Shoulder|Sub\s*Weapon|Secondary\s*Weapon|Shield|Katara/i;
const ELIGIBLE_NON_WEAPON_TYPE = /\bHat\b|Face\s*Acc|Eye\s*Acc|Earring|\bTop\b|Overall|Outfit|Bottom|Shoes|Glove|Cape|Pendant|Belt|Pocket/i;

function parseCSV(text) {
  const lines = String(text).replace(/^\ufeff/, '').split(/\r?\n/).filter((line) => line.trim());
  if (!lines.length) return [];
  const split = (line) => {
    const out = [];
    let cur = '', quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (quoted && line[i + 1] === '"') { cur += '"'; i++; }
        else quoted = !quoted;
      } else if (ch === ',' && !quoted) {
        out.push(cur); cur = '';
      } else cur += ch;
    }
    out.push(cur);
    return out;
  };
  const headers = split(lines[0]);
  return lines.slice(1).map((line) => {
    const values = split(line);
    return Object.fromEntries(headers.map((h, i) => [h, values[i] ?? '']));
  });
}

export function parseFlameData({ tierProbabilitiesText, lineProbabilitiesText }) {
  const tiers = parseCSV(tierProbabilitiesText).map((row) => ({
    source_type: row.source_type,
    advantaged: row.advantaged === 'true',
    tier: Number(row.tier),
    probability: Number(row.probability),
  }));
  const lines = parseCSV(lineProbabilitiesText).map((row) => ({
    method: row.method,
    advantaged: row.advantaged === 'true',
    line_count: Number(row.line_count),
    probability: Number(row.probability),
  }));
  return { tiers, lines, cache: new Map() };
}

// 非武器の判定で使用する追加オプション値。巨大な転載表を持たず、
// IL帯ごとの規則をコードで表現する。tierは1～7の整数を想定する。
export function lookupStatValue(_data, statGroup, itemLevel, tier, scope = 'non_weapon') {
  const lv = Number(itemLevel);
  const t = Number(tier);
  if (!Number.isSafeInteger(lv) || lv < 0 || !Number.isInteger(t) || t < 1 || t > 7) return null;
  if (statGroup === 'single_stat') {
    const perTier = lv >= 230 ? 12 : lv >= 200 ? 11 : Math.floor(lv / 20) + 1;
    return perTier * t;
  }
  if (statGroup === 'dual_stat') {
    const perTier = lv >= 250 ? 7 : lv >= 200 ? 6 : Math.floor(lv / 40) + 1;
    return perTier * t;
  }
  if (statGroup === 'attack_magic') return lv >= 60 ? t : null;
  if (statGroup === 'all_stats_pct') return scope === 'weapon' || lv >= 70 ? t : null;
  return null;
}

function nonNegative(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 && n <= MAX_WEIGHT ? n : fallback;
}

export function normalizeFlameSettings(settings = {}) {
  const mainStat = STAT_NAMES.includes(settings.mainStat) ? settings.mainStat : 'STR';
  const secondaryStat = STAT_NAMES.includes(settings.secondaryStat) && settings.secondaryStat !== mainStat
    ? settings.secondaryStat : DEFAULT_SECONDARY[mainStat];
  return {
    settingsVersion: SETTINGS_VERSION,
    mainStat,
    secondaryStat,
    secondaryWeight: nonNegative(settings.secondaryWeight, 0.1),
    allStatWeight: nonNegative(settings.allStatWeight, 10),
    attackWeight: nonNegative(settings.attackWeight, 4),
    attackType: settings.attackType === 'magic_att' ? 'magic_att' : 'attack_power',
    sourceType: ['powerful', 'eternal_black'].includes(settings.sourceType)
      ? settings.sourceType : 'eternal_black',
  };
}

export function migrateFlameSettings(settings = {}) {
  const saved = settings && typeof settings === 'object' && !Array.isArray(settings) ? settings : {};
  const mainStat = STAT_NAMES.includes(saved.mainStat) ? saved.mainStat : 'STR';
  const savedVersion = Number(saved.settingsVersion);
  const isLegacy = !Number.isFinite(savedVersion) || savedVersion < SETTINGS_VERSION;
  const allStatWeight = isLegacy && Number(saved.allStatWeight) === 15
    ? 10 : saved.allStatWeight;
  const migrated = saved.mainStat ? saved : {
    ...saved,
    secondaryStat: DEFAULT_SECONDARY[mainStat],
    attackType: mainStat === 'INT' ? 'magic_att' : 'attack_power',
  };
  return normalizeFlameSettings({ ...migrated, allStatWeight, mainStat });
}

export function isWeaponType(equipType) {
  const text = String(equipType || '');
  return !/Sub\s*Weapon|Secondary\s*Weapon/i.test(text) && /(^|\/\s*)Weapon\b/i.test(text);
}

export function flameEligibility(item) {
  if (item?.no_bonus_stats) return { kind: 'excluded', reason: '転生対象外' };
  const equipType = String(item?.equip_type || '');
  if (isWeaponType(equipType)) return { kind: 'weapon', reason: '武器は別判定' };
  // equip_typeはOCRのジャンク行が前に連結されることがある(例: "Currently Equipped / - / Pocket Item")。
  // 部位は必ず最後のチップなので、そこだけを見て誤判定を防ぐ。
  const part = equipType.split('/').pop().trim();
  if (EXCLUDED_TYPE.test(part)) return { kind: 'excluded', reason: '転生対象外の部位' };
  if (!ELIGIBLE_NON_WEAPON_TYPE.test(part)) return { kind: 'excluded', reason: '部位を判定できません' };
  const rawItemLevel = item.req_level_base ?? item.req_level;
  const itemLevel = typeof rawItemLevel === 'string' && rawItemLevel.trim() === ''
    ? NaN : Number(rawItemLevel);
  if (!Number.isSafeInteger(itemLevel) || itemLevel < 0) {
    return { kind: 'excluded', reason: '装備Lv不正' };
  }
  return { kind: 'non_weapon', itemLevel };
}

export function inferFlameAdvantaged(item) {
  if (item?.flame_advantaged === 'fixed') {
    return { value: 'fixed', source: 'manual_fixed' };
  }
  if (typeof item?.flame_advantaged === 'boolean') {
    return { value: item.flame_advantaged, source: 'manual' };
  }
  const name = String(item?.item_name || '');
  if (ADVANTAGED_NAME_PATTERNS.some((re) => re.test(name))) {
    return { value: true, source: 'name' };
  }
  return { value: null, source: 'unknown' };
}

export function scoreNonWeapon(item, settings) {
  const normalized = normalizeFlameSettings(settings);
  const main = normalized.mainStat.toLowerCase();
  const secondary = normalized.secondaryStat.toLowerCase();
  const attackKey = normalized.attackType === 'magic_att' ? 'magic_att_bonus' : 'attack_power_bonus';
  const fields = [
    [`${main}_bonus`, 'mainBonus'],
    [`${secondary}_bonus`, 'secondaryBonus'],
    ['all_stats_pct_bonus', 'allBonus'],
    [attackKey, 'attackBonus'],
  ];
  const values = {};
  const invalidFields = [];
  for (const [field, resultKey] of fields) {
    const raw = item?.[field];
    if (raw === undefined || raw === null || raw === '') {
      values[resultKey] = 0;
      continue;
    }
    const numericType = typeof raw === 'number' ||
      (typeof raw === 'string' && raw.trim() !== '');
    const value = numericType ? Number(raw) : NaN;
    if (!Number.isSafeInteger(value) || value < 0) {
      values[resultKey] = null;
      invalidFields.push(field);
    } else {
      values[resultKey] = value;
    }
  }
  const { mainBonus, secondaryBonus, allBonus, attackBonus } = values;
  if (invalidFields.length) {
    return { valid: false, score: null, mainBonus, secondaryBonus, allBonus, attackBonus, invalidFields };
  }
  const score = mainBonus +
    secondaryBonus * normalized.secondaryWeight +
    allBonus * normalized.allStatWeight +
    attackBonus * normalized.attackWeight;
  if (!Number.isFinite(score) || Math.abs(score * SCORE_SCALE) > Number.MAX_SAFE_INTEGER) {
    return {
      valid: false, score: null, mainBonus, secondaryBonus, allBonus, attackBonus,
      invalidFields: ['flame_score'],
    };
  }
  return {
    valid: true,
    score: Math.round(score * SCORE_SCALE) / SCORE_SCALE,
    mainBonus, secondaryBonus, allBonus, attackBonus,
  };
}

function statWeight(stat, settings) {
  if (stat === settings.mainStat) return 1;
  if (stat === settings.secondaryStat) return Number(settings.secondaryWeight);
  return 0;
}

function optionLines(data, itemLevel, settings) {
  const single = lookupStatValue(data, 'single_stat', itemLevel, 1);
  const dual = lookupStatValue(data, 'dual_stat', itemLevel, 1);
  const lines = [];
  for (const stat of STAT_NAMES) {
    lines.push({ id: stat, perTier: single * statWeight(stat, settings) });
  }
  for (const pair of DUAL_STATS) {
    lines.push({ id: pair.join('_'), perTier: dual * (statWeight(pair[0], settings) + statWeight(pair[1], settings)) });
  }
  // スコア0の選択肢も「抽選枠を消費する」ため、個別ラインとして残す。
  lines.push({ id: 'max_hp', perTier: 0 }, { id: 'max_mp', perTier: 0 });
  if (itemLevel >= 1) lines.push({ id: 'level_reduction', perTier: 0 });
  lines.push({ id: 'defense', perTier: 0 });
  if (lookupStatValue(data, 'attack_magic', itemLevel, 1) !== null) {
    lines.push({ id: 'attack_power', perTier: settings.attackType === 'attack_power' ? Number(settings.attackWeight) : 0 });
    lines.push({ id: 'magic_att', perTier: settings.attackType === 'magic_att' ? Number(settings.attackWeight) : 0 });
  }
  lines.push({ id: 'speed', perTier: 0 }, { id: 'jump', perTier: 0 });
  if (lookupStatValue(data, 'all_stats_pct', itemLevel, 1) !== null) {
    lines.push({ id: 'all_stats_pct', perTier: Number(settings.allStatWeight) });
  }
  return lines;
}

function cacheKey(itemLevel, advantaged, settings) {
  return [itemLevel, advantaged, settings.sourceType, settings.mainStat, settings.secondaryStat,
    settings.secondaryWeight, settings.allStatWeight, settings.attackWeight, settings.attackType].join('|');
}

export function buildFlameDistribution(data, itemLevel, advantaged, settings) {
  settings = normalizeFlameSettings(settings);
  const key = cacheKey(itemLevel, advantaged, settings);
  if (data.cache.has(key)) return data.cache.get(key);
  const tiers = data.tiers.filter((r) => r.source_type === settings.sourceType && r.advantaged === advantaged);
  const lineCounts = data.lines.filter((r) => r.method === 'rebirth_flame' && r.advantaged === advantaged);
  if (!tiers.length || !lineCounts.length) throw new Error('確率表に該当する転生素材・ボス転生区分がありません');
  const options = optionLines(data, itemLevel, settings);
  const maxLines = Math.max(...lineCounts.map((r) => r.line_count));
  const dp = Array.from({ length: maxLines + 1 }, () => new Map());
  dp[0].set(0, 1);
  for (const option of options) {
    for (let count = maxLines; count >= 1; count--) {
      for (const [oldKey, oldMass] of dp[count - 1]) {
        for (const tier of tiers) {
          const scoreKey = oldKey + Math.round(option.perTier * tier.tier * SCORE_SCALE);
          dp[count].set(scoreKey, (dp[count].get(scoreKey) || 0) + oldMass * tier.probability);
        }
      }
    }
  }
  const mixed = new Map();
  for (const lineCount of lineCounts) {
    if (lineCount.line_count > options.length) continue;
    const combinations = choose(options.length, lineCount.line_count);
    for (const [scoreKey, mass] of dp[lineCount.line_count]) {
      const probability = lineCount.probability * mass / combinations;
      mixed.set(scoreKey, (mixed.get(scoreKey) || 0) + probability);
    }
  }
  let cumulative = 0;
  const distribution = [...mixed.entries()].sort((a, b) => a[0] - b[0]).map(([scoreKey, probability]) => {
    cumulative += probability;
    return { score: scoreKey / SCORE_SCALE, probability, cumulative };
  });
  // 浮動小数誤差で最終CDFが1±εになるのを表示側へ漏らさない。
  if (distribution.length) distribution[distribution.length - 1].cumulative = 1;
  data.cache.set(key, distribution);
  return distribution;
}

function choose(n, k) {
  if (k < 0 || k > n) return 0;
  let out = 1;
  for (let i = 1; i <= Math.min(k, n - k); i++) out = out * (n - i + 1) / i;
  return out;
}

export function quantile(distribution, probability) {
  return distribution.find((row) => row.cumulative + 1e-12 >= probability)?.score ?? null;
}

export function percentileOf(distribution, score) {
  let lo = 0, hi = distribution.length - 1, found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (distribution[mid].score <= score + 1e-9) { found = mid; lo = mid + 1; }
    else hi = mid - 1;
  }
  return found >= 0 ? distribution[found].cumulative : 0;
}

export function formatFlamePercentile(percentile) {
  if (percentile === null || percentile === undefined || !Number.isFinite(percentile)) return '—';
  const bounded = Math.max(0, Math.min(1, percentile));
  if (bounded === 1) return '100%';
  const percent = bounded * 100;
  if (bounded >= 0.999) {
    const rounded = percent.toFixed(4);
    if (Number(rounded) >= 100) return '>99.9999%';
    return `${rounded.replace(/0+$/, '').replace(/\.$/, '')}%`;
  }
  return `${percent.toFixed(1)}%`;
}

export function improvementStats(distribution, currentScore) {
  if (!Array.isArray(distribution) || !distribution.length || !Number.isFinite(currentScore)) {
    return { probability: null, expectedAttempts: null };
  }
  // 同点は更新に含めない。1-CDFでは極小確率が丸め落ちるため、上側確率を直接合計する。
  let lo = 0, hi = distribution.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (distribution[mid].score <= currentScore + 1e-9) lo = mid + 1;
    else hi = mid;
  }
  let upperTail = 0;
  for (let i = lo; i < distribution.length; i++) upperTail += distribution[i].probability;
  const probability = Math.max(0, Math.min(1, upperTail));
  return {
    probability,
    expectedAttempts: probability > 0 ? 1 / probability : Infinity,
  };
}

export function flameBand(percentile) {
  if (percentile < 0.8) return { rank: 1, key: 'urgent', label: '最優先' };
  if (percentile < 0.95) return { rank: 2, key: 'candidate', label: '更新候補' };
  if (percentile < 0.99) return { rank: 3, key: 'average', label: '平均以上' };
  if (percentile < 0.999) return { rank: 4, key: 'good', label: '良好' };
  return { rank: 5, key: 'excellent', label: '最高水準' };
}

export function evaluateFlameItem(item, data, settings, advantaged) {
  const eligibility = flameEligibility(item);
  if (eligibility.kind !== 'non_weapon') return { eligibility };
  if (advantaged === 'fixed') {
    return {
      eligibility, valid: true, score: null, percentile: null, targets: null,
      improvementProbability: null, expectedAttempts: null,
      unsupportedReason: '特殊な固定Tier装備',
      band: { rank: 9, key: 'unknown', label: '対象外' },
    };
  }
  const scored = scoreNonWeapon(item, settings);
  if (!scored.valid) {
    return {
      eligibility, ...scored, percentile: null, targets: null,
      improvementProbability: null, expectedAttempts: null,
      band: { rank: 8, key: 'unknown', label: '値を確認' },
    };
  }
  if (typeof advantaged !== 'boolean') {
    return {
      eligibility, ...scored, percentile: null, improvementProbability: null, expectedAttempts: null,
      band: { rank: 10, key: 'unknown', label: '判定待ち' },
    };
  }
  const distribution = buildFlameDistribution(data, eligibility.itemLevel, advantaged, settings);
  const percentile = percentileOf(distribution, scored.score);
  const improvement = improvementStats(distribution, scored.score);
  const targets = {
    p80: quantile(distribution, 0.8),
    p95: quantile(distribution, 0.95),
    p99: quantile(distribution, 0.99),
    p999: quantile(distribution, 0.999),
  };
  return {
    eligibility, ...scored, distribution, percentile, targets,
    improvementProbability: improvement.probability,
    expectedAttempts: improvement.expectedAttempts,
    band: flameBand(percentile),
  };
}
