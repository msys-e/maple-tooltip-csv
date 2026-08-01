import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  parseFlameData, lookupStatValue, scoreNonWeapon, buildFlameDistribution, normalizeFlameSettings,
  migrateFlameSettings, quantile, percentileOf, formatFlamePercentile, improvementStats,
  flameBand, inferFlameAdvantaged, flameEligibility, evaluateFlameItem,
} from '../js/flame.js';
import { COLUMNS } from '../js/csv.js';

const root = new URL('../', import.meta.url);
const text = (path) => readFileSync(new URL(path, root), 'utf8');
const data = parseFlameData({
  tierProbabilitiesText: text('data/flame_tier_probabilities.csv'),
  lineProbabilitiesText: text('data/flame_line_probabilities.csv'),
});
const settings = {
  mainStat: 'STR', secondaryStat: 'DEX', secondaryWeight: 0.1,
  allStatWeight: 10, attackWeight: 4, attackType: 'attack_power',
  sourceType: 'eternal_black',
};

// 装備Lvは強化表のように丸めず、転生値表の区間を正確に引く。
assert.equal(lookupStatValue(data, 'single_stat', 159, 5), 40);
assert.equal(lookupStatValue(data, 'single_stat', 160, 5), 45);
assert.equal(lookupStatValue(data, 'single_stat', 179, 5), 45);
assert.equal(lookupStatValue(data, 'single_stat', 180, 5), 50);
assert.equal(lookupStatValue(data, 'single_stat', 229, 5), 55);
assert.equal(lookupStatValue(data, 'single_stat', 230, 5), 60);
assert.equal(lookupStatValue(data, 'dual_stat', 249, 5), 30);
assert.equal(lookupStatValue(data, 'dual_stat', 250, 5), 35);

const daybreak = {
  item_name: 'Daybreak Pendant', equip_type: 'Accessory / Pendant', req_level: 140,
  str_bonus: 64, luk_bonus: 64, all_stats_pct_bonus: 5,
};
const berserked = {
  item_name: 'Berserked', equip_type: 'Accessory / Face Acc', req_level: 160,
  str_bonus: 75, int_bonus: 30, attack_power_bonus: 4, all_stats_pct_bonus: 6,
};
assert.equal(scoreNonWeapon(daybreak, settings).score, 114);
assert.equal(scoreNonWeapon(berserked, settings).score, 151);
assert.equal(scoreNonWeapon(berserked, settings).valid, true);
assert.deepEqual(scoreNonWeapon({ str_bonus: 'abc' }, settings).invalidFields, ['str_bonus']);
assert.equal(scoreNonWeapon({ str_bonus: -1 }, settings).valid, false);
assert.equal(scoreNonWeapon({ str_bonus: 'Infinity' }, settings).valid, false);
assert.equal(scoreNonWeapon({ str_bonus: false }, settings).valid, false);
assert.equal(scoreNonWeapon({ str_bonus: '  ' }, settings).valid, false);
assert.equal(scoreNonWeapon({ str_bonus: 1.5 }, settings).valid, false);
assert.equal(scoreNonWeapon({ all_stats_pct_bonus: 5 }, { ...settings, allStatWeight: 1e308 }).score, 50);
assert.equal(normalizeFlameSettings({ ...settings, allStatWeight: 1e308 }).allStatWeight, 10);
assert.equal(normalizeFlameSettings(settings).settingsVersion, 2);
assert.equal(migrateFlameSettings({ settingsVersion: 1, allStatWeight: 15 }).allStatWeight, 10);
assert.equal(migrateFlameSettings({ allStatWeight: 15 }).allStatWeight, 10);
assert.equal(migrateFlameSettings({ settingsVersion: 1, allStatWeight: 12 }).allStatWeight, 12);
assert.equal(migrateFlameSettings({ settingsVersion: 2, allStatWeight: 15 }).allStatWeight, 15);
const duplicateStats = normalizeFlameSettings({ ...settings, secondaryStat: 'STR' });
assert.equal(duplicateStats.secondaryStat, 'DEX');
assert.equal(scoreNonWeapon({ str_bonus: 100, dex_bonus: 50 }, { ...settings, secondaryStat: 'STR' }).score, 105);

const advantaged = buildFlameDistribution(data, 160, true, settings);
const normal = buildFlameDistribution(data, 160, false, settings);
const sum = advantaged.reduce((total, row) => total + row.probability, 0);
assert.ok(Math.abs(sum - 1) < 1e-10, `probability sum=${sum}`);
assert.ok(quantile(advantaged, 0.8) <= quantile(advantaged, 0.95));
assert.ok(quantile(advantaged, 0.95) <= quantile(advantaged, 0.99));
assert.ok(quantile(advantaged, 0.95) > quantile(normal, 0.95));
assert.ok(percentileOf(advantaged, -1) === 0);
assert.ok(percentileOf(advantaged, 9999) === 1);
assert.equal(formatFlamePercentile(null), '—');
assert.equal(formatFlamePercentile(0.95), '95.0%');
assert.equal(formatFlamePercentile(0.9999509861558303), '99.9951%');
assert.equal(formatFlamePercentile(0.9999999), '>99.9999%');
assert.equal(formatFlamePercentile(1), '100%');
const sampleDistribution = [
  { score: 10, probability: 0.5, cumulative: 0.5 },
  { score: 20, probability: 0.3, cumulative: 0.8 },
  { score: 30, probability: 0.2, cumulative: 1 },
];
assert.deepEqual(improvementStats(sampleDistribution, -1), { probability: 1, expectedAttempts: 1 });
assert.deepEqual(improvementStats(sampleDistribution, 10), { probability: 0.5, expectedAttempts: 2 });
assert.ok(Math.abs(improvementStats(sampleDistribution, 20).probability - 0.2) < 1e-12);
assert.ok(Math.abs(improvementStats(sampleDistribution, 20).expectedAttempts - 5) < 1e-12);
assert.deepEqual(improvementStats(sampleDistribution, 30), { probability: 0, expectedAttempts: Infinity });
assert.deepEqual(improvementStats([], 10), { probability: null, expectedAttempts: null });
assert.equal(flameBand(0.999).label, '最高水準');
const tinyUpperTail = [
  { score: 10, probability: 1, cumulative: 1 },
  { score: 20, probability: 1e-18, cumulative: 1 },
];
assert.equal(improvementStats(tinyUpperTail, 10).probability, 1e-18);
assert.ok(Math.abs(improvementStats(tinyUpperTail, 10).expectedAttempts / 1e18 - 1) < 1e-12);

const allTwelve = { ...settings, allStatWeight: 12 };
const changed = buildFlameDistribution(data, 160, true, allTwelve);
assert.notEqual(quantile(advantaged, 0.95), quantile(changed, 0.95));
assert.equal(scoreNonWeapon(berserked, allTwelve).score, 163);

assert.deepEqual(inferFlameAdvantaged(daybreak), { value: true, source: 'name' });
for (const itemName of [
  'Royal Warrior Helm',
  'Royal Dunwitch Hat',
  'Royal Ranger Beret',
  'Royal Assassin Hood',
  'Royal Wanderer Hat',
  'Eagle Eye Warrior Armor',
  'Eagle Eye Dunwitch Robe',
  'Eagle Eye Ranger Cowl',
  'Eagle Eye Assassin Shirt',
  'Eagle Eye Wanderer Coat',
  'Trixter Warrior Pants',
  'Trixter Dunwitch Pants',
  'Trixter Ranger Pants',
  'Trixter Assassin Pants',
  'Trixter Wanderer Pants',
  'Berserked',
  'Magic Eyepatch',
  'Source of Suffering',
  'Cursed Red Spellbook',
  'Commanding Force Earring',
  'Dreamy Belt',
  'Original Sin of Pride',
  'Oath of Death',
]) {
  assert.deepEqual(
    inferFlameAdvantaged({ item_name: itemName }),
    { value: true, source: 'name' },
    `${itemName} should be inferred as flame-advantaged`,
  );
}
assert.deepEqual(inferFlameAdvantaged({ item_name: 'Royal Von Leon Suit' }), { value: null, source: 'unknown' });
assert.deepEqual(inferFlameAdvantaged({ ...daybreak, flame_advantaged: false }), { value: false, source: 'manual' });
assert.deepEqual(inferFlameAdvantaged({ ...daybreak, flame_advantaged: 'fixed' }), { value: 'fixed', source: 'manual_fixed' });
assert.deepEqual(inferFlameAdvantaged({ item_name: 'Unknown Cape' }), { value: null, source: 'unknown' });
assert.equal(flameEligibility(daybreak).kind, 'non_weapon');
assert.equal(flameEligibility({ equip_type: 'Accessory / Earrings', req_level: 200 }).kind, 'non_weapon');
assert.equal(flameEligibility({ equip_type: 'Accessory / Ring', no_bonus_stats: true }).kind, 'excluded');
for (const item of [
  { item_name: 'Black Heart', equip_type: 'Android Heart' },
  { item_name: 'Endless Terror', equip_type: 'Accessory / Ring' },
  { item_name: 'Genesis Badge', equip_type: 'Badge' },
  { item_name: "Mitra's Rage: Warrior", equip_type: 'Emblem' },
  { item_name: 'Total Control', equip_type: 'Android Heart' },
  { item_name: 'Whisper of the Source', equip_type: 'Accessory / Ring' },
  { item_name: 'Blissful Nightmare', equip_type: 'Accessory / Ring' },
  { item_name: 'Immortal Legacy', equip_type: 'Medal' },
]) {
  assert.equal(flameEligibility(item).kind, 'excluded', `${item.item_name} should remain excluded`);
}
assert.equal(flameEligibility({ equip_type: 'Weapon One-handed / Sword', req_level: 200 }).kind, 'weapon');
assert.equal(flameEligibility({ equip_type: 'Armor / Hat', req_level: '' }).kind, 'excluded');
assert.equal(flameEligibility({ equip_type: 'Armor / Hat', req_level: -1 }).kind, 'excluded');
assert.equal(flameEligibility({ equip_type: 'Armor / Hat', req_level: 160.5 }).kind, 'excluded');
assert.equal(flameEligibility({ equip_type: 'Armor / Hat', req_level: Number.MAX_SAFE_INTEGER + 1 }).kind, 'excluded');
assert.equal(flameEligibility({ equip_type: 'Armor / Hat', req_level: 0 }).kind, 'non_weapon');

assert.deepEqual(COLUMNS.slice(0, 6), [
  'timestamp', 'item_name', 'equip_type', 'req_level', 'star_count', 'flags',
]);
assert.deepEqual(COLUMNS.slice(-2), ['req_level_base', 'flame_advantaged']);

const evaluated = evaluateFlameItem(berserked, data, settings, true);
assert.equal(evaluated.score, 151);
assert.ok(evaluated.percentile >= 0 && evaluated.percentile <= 1);
assert.ok(Math.abs(evaluated.improvementProbability - (1 - evaluated.percentile)) < 1e-12);
assert.ok(Math.abs(evaluated.expectedAttempts - (1 / evaluated.improvementProbability)) < 1e-12);
assert.ok(evaluated.targets.p80 <= evaluated.targets.p95 && evaluated.targets.p95 <= evaluated.targets.p99 &&
  evaluated.targets.p99 <= evaluated.targets.p999);
const pending = evaluateFlameItem({ ...daybreak, item_name: 'Unknown Pendant' }, data, settings, null);
assert.equal(pending.percentile, null);
assert.equal(pending.band.label, '判定待ち');
const invalid = evaluateFlameItem({ ...daybreak, str_bonus: 'abc' }, data, settings, true);
assert.equal(invalid.score, null);
assert.equal(invalid.percentile, null);
assert.equal(invalid.band.label, '値を確認');
const fixed = evaluateFlameItem(daybreak, data, settings, 'fixed');
assert.equal(fixed.percentile, null);
assert.equal(fixed.band.label, '対象外');
assert.equal(fixed.unsupportedReason, '特殊な固定Tier装備');
const fixedInvalid = evaluateFlameItem({ ...daybreak, str_bonus: 'abc' }, data, settings, 'fixed');
assert.equal(fixedInvalid.band.label, '対象外');
assert.equal(fixedInvalid.unsupportedReason, '特殊な固定Tier装備');

console.log(`flame: OK (${advantaged.length} score buckets, p95=${quantile(advantaged, 0.95)})`);
