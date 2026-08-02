import assert from 'node:assert/strict';
import { CLASSES, CLASS_MAIN_STATS, classMainStat, flameUnsupportedReason } from '../js/classes.js';
import { DEFAULT_SECONDARY } from '../js/flame.js';

const expected = {
  Adele: 'STR',
  'Angelic Buster': 'DEX',
  Aran: 'STR',
  Ark: 'STR',
  'Battle Mage': 'INT',
  Bishop: 'INT',
  Blaster: 'STR',
  'Blaze Wizard': 'INT',
  Bowmaster: 'DEX',
  Buccaneer: 'STR',
  Cadena: 'LUK',
  Cannoneer: 'STR',
  Corsair: 'DEX',
  'Dark Knight': 'STR',
  'Dawn Warrior': 'STR',
  'Demon Avenger': null,
  'Demon Slayer': 'STR',
  'Dual Blade': 'LUK',
  Erel: 'STR',
  Evan: 'INT',
  'Fire/Poison Mage': 'INT',
  Hayato: 'STR',
  Hero: 'STR',
  Hoyoung: 'LUK',
  'Ice/Lightning Mage': 'INT',
  Illium: 'INT',
  Kain: 'DEX',
  Kaiser: 'STR',
  Kanna: 'INT',
  Khali: 'LUK',
  Kinesis: 'INT',
  Lara: 'INT',
  Luminous: 'INT',
  Lynn: 'INT',
  Marksman: 'DEX',
  Mechanic: 'DEX',
  Mercedes: 'DEX',
  Mihile: 'STR',
  'Mo Xuan': 'STR',
  'Night Lord': 'LUK',
  'Night Walker': 'LUK',
  Paladin: 'STR',
  Pathfinder: 'DEX',
  Phantom: 'LUK',
  Ren: 'STR',
  Shade: 'STR',
  Shadower: 'LUK',
  'Sia Astelle': 'INT',
  'Thunder Breaker': 'STR',
  'Wild Hunter': 'DEX',
  'Wind Archer': 'DEX',
  Xenon: null,
  Zero: 'STR',
};

assert.equal(CLASSES.length, 53);
assert.deepEqual(new Set(Object.keys(CLASS_MAIN_STATS)), new Set(CLASSES));
assert.deepEqual(CLASS_MAIN_STATS, expected);

for (const className of CLASSES) {
  const mainStat = classMainStat(className);
  assert.equal(mainStat, expected[className]);
  if (mainStat) {
    assert.equal(DEFAULT_SECONDARY[mainStat] !== undefined, true);
    assert.equal(mainStat === 'INT' ? 'magic_att' : 'attack_power',
      expected[className] === 'INT' ? 'magic_att' : 'attack_power');
  }
}

assert.match(flameUnsupportedReason('Demon Avenger'), /HP/);
assert.match(flameUnsupportedReason('Xenon'), /STR\/DEX\/LUK/);
assert.equal(flameUnsupportedReason('Hero'), '');
assert.equal(classMainStat('Missing Class'), undefined);

console.log('classes: OK');
