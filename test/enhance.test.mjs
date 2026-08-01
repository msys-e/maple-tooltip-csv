// planStep / buildPlan のユニットテスト (codexレビューの非blockingメモ対応)
// 合成した効率表行×装備で star/potential 分岐の回帰を検知する
import { planStep, buildPlan, partOf, nearestLv } from '../js/enhance.js';

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

console.log(`enhance: pass=${pass} fail=${fail}`);
process.exitCode = fail ? 1 : 0;
