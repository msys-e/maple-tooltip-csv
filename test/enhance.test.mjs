import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// planStep / buildPlan のユニットテスト (codexレビューの非blockingメモ対応)
// 合成した効率表行×装備で star/potential 分岐の回帰を検知する
import {
  CUBE_SALE_DISCOUNT,
  buildPlan,
  effectivePlanCost,
  nearestLv,
  parseRankingCSV,
  partOf,
  planStep,
} from '../js/enhance.js';

let pass = 0, fail = 0;
function eq(label, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) { pass++; return; }
  fail++;
  console.log(` NG ${label}: got=${JSON.stringify(got)} want=${JSON.stringify(want)}`);
}

// --- 合成テーブル行 ---
const starRow = (lv, s0, s1) => ({ kind: 'star', lv, s0, s1, item: `スタフォ ${s0}→${s1}★`, setting: 'x', mps: 1, meso: 1, score: 1 });
const potRow = (lv, part, goal, from) => ({ kind: 'pot', lv, part, goal, from, item: `潜在 ${part} / ${goal} ←${from}`, setting: 'x', mps: 1, meso: 1, score: 1 });

// --- 装備fixture ---
const glove = (over) => ({
  item_name: 'g', equip_type: 'Armor / Gloves', req_level: 200, star_count: 22,
  potential_grade: 'Legendary',
  pot1_text: 'STR: +13%', pot2_text: 'All Stats +7%', pot3_text: 'DEX: +10%',
  ...over,
});

// nearestLv / partOf
eq('nearestLv 140→150', nearestLv(140), 150);
eq('nearestLv 120→100', nearestLv(120), 100);
eq('nearestLv 不明', nearestLv(undefined), null);
eq('partOf SubWeapon優先', partOf('Sub Weapon / Imugi Gem'), '補助武器');
eq('partOf Emblem優先', partOf('Emblem / Power Source / Emblem'), 'エンブレム');
eq('partOf Weapon', partOf('Weapon One-handed / Sword'), '武器');

// --- star 分岐 ---
eq('star 0→18 s=17 は next', planStep(glove({ star_count: 17 }), starRow(200, 0, 18), 'STR'), 'next');
eq('star 0→18 s=18 は null', planStep(glove({ star_count: 18 }), starRow(200, 0, 18), 'STR'), null);
eq('star 18→19 s=18 は next', planStep(glove({ star_count: 18 }), starRow(200, 18, 19), 'STR'), 'next');
eq('star 21→22 s=18 は future', planStep(glove({ star_count: 18 }), starRow(200, 21, 22), 'STR'), 'future');
eq('star 18→19 s=22 は null(通過済)', planStep(glove({ star_count: 22 }), starRow(200, 18, 19), 'STR'), null);
eq('star 空文字は null', planStep(glove({ star_count: '' }), starRow(200, 0, 18), 'STR'), null);
eq('star スタフォ不可は null', planStep(glove({ no_starforce: 1, star_count: 17 }), starRow(200, 0, 18), 'STR'), null);
eq('star Lv違いは null', planStep(glove({ star_count: 18 }), starRow(160, 18, 19), 'STR'), null);

// --- potential 分岐 ---
const inclRow = potRow(200, '手袋', '主ステ%3ライン(ALLステ%含む)', '2ライン');
const exclRow = potRow(200, '手袋', '主ステ%3ライン(ALLステ%除く)', '2ライン');
// STR+ALL+DEX → incl=2, excl=1
eq('pot incl←2 cur=2 は next', planStep(glove(), inclRow, 'STR'), 'next');
eq('pot excl←2 cur=1 は future', planStep(glove(), exclRow, 'STR'), 'future');
// STR/STR/ALL → incl=3(達成), excl=2
eq('pot incl 達成済は null',
  planStep(glove({ pot2_text: 'STR: +10%', pot3_text: 'All Stats +7%' }), inclRow, 'STR'), null);
eq('pot excl←2 cur=2 は next',
  planStep(glove({ pot2_text: 'STR: +10%', pot3_text: 'All Stats +7%' }), exclRow, 'STR'), 'next');
// STR/STR/STR → 両方達成
eq('pot excl 達成済は null',
  planStep(glove({ pot2_text: 'STR: +10%', pot3_text: 'STR: +10%' }), exclRow, 'STR'), null);
// レジェ未達・部位違い
eq('pot Unique装備は null', planStep(glove({ potential_grade: 'Unique' }), inclRow, 'STR'), null);
eq('pot 部位違いは null', planStep(glove({ equip_type: 'Armor / Hat' }), inclRow, 'STR'), null);
// 主ステ切替: DEX視点だと STR+ALL+DEX → incl=2 (DEX,ALL)
eq('pot mainStat=DEX でも incl←2 は next', planStep(glove(), potRow(200, '手袋', '主ステ%3ライン(ALLステ%含む)', '2ライン'), 'DEX'), 'next');
// クリダメ遷移(from側の種別指定)
const critMix = potRow(200, '手袋', 'クリダメ%2ライン+ステ%1ライン', 'クリダメ1ライン');
eq('pot クリダメ←1 cur=1 は next',
  planStep(glove({ pot1_text: 'Critical Damage +8%', pot2_text: 'STR: +10%', pot3_text: 'DEX: +10%' }), critMix, 'STR'), 'next');

// --- buildPlan ---
const table = [starRow(200, 18, 19), starRow(200, 21, 22), inclRow, exclRow];
const items = [glove({ star_count: 18 })];
eq('buildPlan 既定は next のみ', buildPlan(items, table, 'STR').map((p) => p.row.item),
  ['スタフォ 18→19★', '潜在 手袋 / 主ステ%3ライン(ALLステ%含む) ←2ライン']);
eq('buildPlan includeFuture で future も',
  buildPlan(items, table, 'STR', { includeFuture: true }).length, 4);
eq('buildPlan immediate フラグ',
  buildPlan(items, table, 'STR', { includeFuture: true }).filter((p) => p.immediate).length, 2);

// 設定名以外の計算結果が完全一致する候補は、同一装備では1アクションにまとめる。
const duplicateStarRows = [
  { ...starRow(150, 20, 21), setting: '1144 / モード4', meso: 1.811, score: 67, mps: 27.03 },
  { ...starRow(150, 20, 21), setting: '4444 / モード4', meso: 1.811, score: 67, mps: 27.03 },
];
const duplicateItem = glove({ req_level: 150, star_count: 20 });
const deduplicated = buildPlan([duplicateItem], duplicateStarRows, 'STR');
assert.equal(deduplicated.length, 1);
assert.equal(deduplicated[0].row.setting, '1144 / 4444（同一結果）');
assert.deepEqual(deduplicated[0].equivalentSettings, ['1144 / モード4', '4444 / モード4']);
assert.deepEqual(duplicateStarRows.map((row) => row.setting), ['1144 / モード4', '4444 / モード4']);
assert.equal(buildPlan([duplicateItem], duplicateStarRows, 'STR')[0].row.setting, '1144 / 4444（同一結果）');

// 数値として等価な+0/-0は統合し、計算不能なNaN同士は同一結果とみなさない。
const signedZeroResults = [
  { ...duplicateStarRows[0], setting: '正のゼロ', meso: 0, mps: 0 },
  { ...duplicateStarRows[0], setting: '負のゼロ', meso: -0, mps: -0 },
];
assert.equal(buildPlan([duplicateItem], signedZeroResults, 'STR').length, 1);
const invalidResults = [
  { ...duplicateStarRows[0], setting: '不正値A', mps: Number.NaN },
  { ...duplicateStarRows[0], setting: '不正値B', mps: Number.NaN },
];
assert.equal(buildPlan([duplicateItem], invalidResults, 'STR').length, 2);

// 期待メソ・スコア・効率のいずれかが異なる設定は、従来どおり別アクションにする。
const distinctResults = [
  { ...duplicateStarRows[0], setting: '基準' },
  { ...duplicateStarRows[0], setting: '期待メソ違い', meso: 1.812 },
  { ...duplicateStarRows[0], setting: 'スコア違い', score: 68 },
  { ...duplicateStarRows[0], setting: '効率違い', mps: 27.04 },
];
assert.equal(buildPlan([duplicateItem], distinctResults, 'STR').length, 4);

// 同じ計算結果でも装備が違えば、それぞれ1アクションとして残す。
assert.equal(buildPlan([duplicateItem, { ...duplicateItem, item_name: 'g2' }], duplicateStarRows, 'STR').length, 2);

// 実データでIssue #4の全8組(Lv150/160/200/250 × 20→21★/21→22★)を回帰確認する。
const rankingTable = parseRankingCSV(readFileSync(new URL('../data/ranking.csv', import.meta.url), 'utf8'));
const issue4Items = [150, 160, 200, 250].flatMap((lv) => [20, 21].map((star_count) => ({
  item_name: `Lv${lv} ★${star_count}`,
  equip_type: 'Armor / Gloves',
  req_level: lv,
  star_count,
})));
const issue4Plan = buildPlan(issue4Items, rankingTable, 'STR');
assert.equal(issue4Plan.length, 8);
assert.ok(issue4Plan.every((entry) => entry.row.setting === '1144 / 4444（同一結果）'));
assert.ok(issue4Plan.every((entry) => entry.equivalentSettings.length === 2));

// ★20装備の全段階表示でも、20→21★と将来の21→22★は各装備1行ずつになる。
const issue4FutureItems = issue4Items.filter((item) => item.star_count === 20);
const issue4FuturePlan = buildPlan(issue4FutureItems, rankingTable, 'STR', { includeFuture: true });
const issue4FutureRows = issue4FuturePlan.filter((entry) => entry.row.s0 === 20 || entry.row.s0 === 21);
assert.equal(issue4FutureRows.length, 8);
assert.ok(issue4FutureRows.every((entry) => entry.row.setting === '1144 / 4444（同一結果）'));
assert.ok(issue4FutureRows.every((entry) => entry.equivalentSettings.length === 2));

// --- キューブセール ---
assert.equal(CUBE_SALE_DISCOUNT, 0.25);

const potential = {
  kind: 'pot', lv: 160, part: '武器', goal: '攻撃%2ライン', from: '1ライン',
  setting: 'グローイングキューブ', meso: 4, score: 100, mps: 40,
};
const starforce = {
  kind: 'star', lv: 160, s0: 0, s1: 18,
  setting: '破壊防止なし', meso: 3.5, score: 100, mps: 35,
};
const nonCubePotential = { ...potential, setting: 'イベント配布', meso: 0, mps: 0 };

assert.deepEqual(effectivePlanCost(potential), { meso: 4, mps: 40, discounted: false });
assert.deepEqual(effectivePlanCost(potential, { cubeSale: true }), { meso: 3, mps: 30, discounted: true });
assert.deepEqual(effectivePlanCost(starforce, { cubeSale: true }), { meso: 3.5, mps: 35, discounted: false });
assert.deepEqual(effectivePlanCost(nonCubePotential, { cubeSale: true }), { meso: 0, mps: 0, discounted: false });

// ranking.csv の mps は丸め済みなので、セール時は割引メソから効率を再計算する。
// 旧実装の 120.2 * 0.75 = 90.15 だと、90.16のスタフォより誤って上位になっていた。
const roundedPotential = { ...potential, meso: 11.975, score: 99.6, mps: 120.2 };
const boundaryStarforce = { ...starforce, meso: 8.385, score: 93, mps: 90.16 };
const roundedSaleCost = effectivePlanCost(roundedPotential, { cubeSale: true });
assert.equal(roundedSaleCost.meso, 8.98125);
assert.ok(Math.abs(roundedSaleCost.mps - 90.17319277108435) < 1e-12);

const weapon = {
  item_name: 'Test Weapon', equip_type: 'Weapon', req_level: 160, star_count: 0,
  potential_grade: 'Legendary', pot1_text: 'Attack Power +12%', pot2_text: '', pot3_text: '',
};
const saleTable = [potential, starforce];
const normal = buildPlan([weapon], saleTable, 'STR');
const sale = buildPlan([weapon], saleTable, 'STR', { cubeSale: true });

assert.deepEqual(normal.map((entry) => entry.row.kind), ['star', 'pot']);
assert.deepEqual(sale.map((entry) => entry.row.kind), ['pot', 'star']);
assert.deepEqual(sale.map((entry) => entry.mps), [30, 35]);

const boundarySale = buildPlan([weapon], [roundedPotential, boundaryStarforce], 'STR', { cubeSale: true });
assert.deepEqual(boundarySale.map((entry) => entry.row.kind), ['star', 'pot']);

// 全段階表示とセールを同時に有効化しても、将来行と割引後コストをどちらも保持する。
const futureSale = buildPlan(
  [glove({ star_count: 18 })],
  [
    { ...starRow(200, 21, 22), meso: 5, score: 100, mps: 50 },
    { ...inclRow, setting: 'ブライトキューブ', meso: 4, score: 100, mps: 40 },
  ],
  'STR',
  { includeFuture: true, cubeSale: true },
);
assert.deepEqual(futureSale.map((entry) => entry.immediate), [true, false]);
assert.deepEqual(futureSale.map((entry) => entry.mps), [30, 50]);

console.log(`enhance: pass=${pass} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
