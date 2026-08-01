import assert from 'node:assert/strict';
import { buildPlan, effectivePlanCost, CUBE_SALE_DISCOUNT } from '../js/enhance.js';

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

const item = {
  item_name: 'Test Weapon', equip_type: 'Weapon', req_level: 160, star_count: 0,
  potential_grade: 'Legendary', pot1_text: 'Attack Power +12%', pot2_text: '', pot3_text: '',
};
const table = [potential, starforce];
const normal = buildPlan([item], table, 'STR');
const sale = buildPlan([item], table, 'STR', { cubeSale: true });

assert.deepEqual(normal.map((entry) => entry.row.kind), ['star', 'pot']);
assert.deepEqual(sale.map((entry) => entry.row.kind), ['pot', 'star']);
assert.deepEqual(sale.map((entry) => entry.mps), [30, 35]);

const boundarySale = buildPlan([item], [roundedPotential, boundaryStarforce], 'STR', { cubeSale: true });
assert.deepEqual(boundarySale.map((entry) => entry.row.kind), ['star', 'pot']);

console.log('enhance: OK');
