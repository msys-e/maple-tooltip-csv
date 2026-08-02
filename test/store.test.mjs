import assert from 'node:assert/strict';

class MemoryStorage {
  constructor() {
    this.map = new Map();
  }

  get length() {
    return this.map.size;
  }

  clear() {
    this.map.clear();
  }

  getItem(key) {
    return this.map.has(key) ? this.map.get(key) : null;
  }

  key(index) {
    return Array.from(this.map.keys())[index] ?? null;
  }

  removeItem(key) {
    this.map.delete(key);
  }

  setItem(key, value) {
    this.map.set(key, String(value));
  }
}

class ThrowingStorage extends MemoryStorage {
  constructor(shouldThrow) {
    super();
    this.shouldThrow = shouldThrow;
  }

  setItem(key, value) {
    if (this.shouldThrow(key, String(value))) {
      throw new DOMException('quota exceeded', 'QuotaExceededError');
    }
    super.setItem(key, value);
  }
}

let importCounter = 0;

async function loadStore(storage = new MemoryStorage()) {
  globalThis.localStorage = storage;
  importCounter += 1;
  return import(`../js/store.js?store-test=${importCounter}`);
}

function characterKey(id, suffix) {
  return `mtc:char:${id}:${suffix}`;
}

function seedJson(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

function characterKeysInStorage() {
  const keys = [];
  for (let i = 0; i < localStorage.length; i += 1) {
    const key = localStorage.key(i);
    if (key?.startsWith('mtc:char:')) keys.push(key);
  }
  return keys;
}

let store = await loadStore();
const legacyItems = [{ item_name: 'Dawn Ring' }];
const legacySnapshots = [{ id: 'snap_a', name: 'before', items: legacyItems }];
const legacyScouter = { slot: '2', values: { str: '100' } };
const legacyFlameSettings = { mainStat: 'STR' };
seedJson('mtc:items', legacyItems);
seedJson('mtc:snapshots', legacySnapshots);
seedJson('mtc:scouter', legacyScouter);
seedJson('mtc:flame-settings', legacyFlameSettings);

assert.deepEqual(store.loadItems(), legacyItems);
assert.deepEqual(store.listSnapshots(), legacySnapshots);
assert.deepEqual(store.loadScouter(), legacyScouter);
assert.deepEqual(store.loadFlameSettings(), legacyFlameSettings);
const migratedId = store.getActiveCharacterId();
assert.equal(localStorage.getItem('mtc:schema'), '3');
assert.equal(localStorage.getItem('mtc:items'), null);
assert.equal(localStorage.getItem('mtc:snapshots'), null);
assert.equal(localStorage.getItem('mtc:scouter'), null);
assert.equal(localStorage.getItem('mtc:flame-settings'), null);
assert.equal(localStorage.getItem(characterKey(migratedId, 'items')), JSON.stringify(legacyItems));
assert.equal(localStorage.getItem(characterKey(migratedId, 'snapshots')), JSON.stringify(legacySnapshots));
assert.equal(localStorage.getItem(characterKey(migratedId, 'scouter')), JSON.stringify(legacyScouter));
assert.equal(localStorage.getItem(characterKey(migratedId, 'flame-settings')), JSON.stringify(legacyFlameSettings));
assert.deepEqual(store.loadItems(), legacyItems);
store.saveItems(legacyItems.concat({ item_name: 'After Migration' }));
store = await loadStore(localStorage);
assert.deepEqual(store.loadItems(), legacyItems.concat({ item_name: 'After Migration' }));
assert.equal(localStorage.getItem(characterKey(migratedId, 'items')), JSON.stringify(legacyItems.concat({ item_name: 'After Migration' })));

store = await loadStore();
const charsForNewUser = store.listCharacters();
assert.equal(charsForNewUser.length, 1);
assert.equal(charsForNewUser[0].name, 'キャラ1');
assert.equal(charsForNewUser[0].class, null);
assert.equal(store.getActiveCharacterId(), charsForNewUser[0].id);
assert.deepEqual(store.loadItems(), []);

store = await loadStore();
const charA = store.listCharacters()[0];
store.saveItems([{ item_name: 'Arcane Cape' }]);
store.saveScouter({ slot: '1', values: { luk: '42' } });
store.saveFlameSettings({ mainStat: 'LUK' });
store.saveSnapshot('A snapshot', [{ item_name: 'Arcane Cape' }]);
const charB = store.createCharacter({ name: 'Second', class: 'Bowmaster' });
assert.equal(store.setActiveCharacter(charB.id), true);
assert.deepEqual(store.loadItems(), []);
assert.deepEqual(store.listSnapshots(), []);
store.saveItems([{ item_name: 'Black Heart' }]);
store.saveSnapshot('B snapshot', [{ item_name: 'Black Heart' }]);
assert.equal(store.setActiveCharacter(charA.id), true);
assert.deepEqual(store.loadItems(), [{ item_name: 'Arcane Cape' }]);
assert.deepEqual(store.loadScouter(), { slot: '1', values: { luk: '42' } });
assert.deepEqual(store.loadFlameSettings(), { mainStat: 'LUK' });
assert.deepEqual(store.listSnapshots().map((s) => s.name), ['A snapshot']);
assert.equal(store.setActiveCharacter(charB.id), true);
assert.deepEqual(store.loadItems(), [{ item_name: 'Black Heart' }]);
assert.deepEqual(store.listSnapshots().map((s) => s.name), ['B snapshot']);

assert.equal(store.renameCharacter(charB.id, 'Renamed'), true);
assert.equal(store.setCharacterClass(charB.id, 'Hero'), true);
assert.deepEqual(
  store.listCharacters().find((c) => c.id === charB.id),
  { id: charB.id, name: 'Renamed', class: 'Hero' },
);
assert.equal(store.setActiveCharacter('missing'), false);
assert.equal(store.renameCharacter('missing', 'Nope'), false);
assert.equal(store.setCharacterClass('missing', 'Nope'), false);

assert.equal(store.deleteCharacter(charB.id), true);
assert.equal(store.getActiveCharacterId(), charA.id);
assert.equal(localStorage.getItem(characterKey(charB.id, 'items')), null);
assert.equal(store.deleteCharacter(charA.id), true);
const replacement = store.listCharacters();
assert.equal(replacement.length, 1);
assert.notEqual(replacement[0].id, charA.id);
assert.equal(store.getActiveCharacterId(), replacement[0].id);
assert.equal(store.deleteCharacter('missing'), false);

store = await loadStore();
const usageChar = store.listCharacters()[0];
store.saveItems([{ item_name: 'Usage Item' }]);
const usage = store.characterStorageUsage();
assert.equal(usage.length, 1);
assert.equal(usage[0].id, usageChar.id);
assert.ok(usage[0].bytes > 0);

const throwingStorage = new ThrowingStorage((key) => key.startsWith('mtc:char:') && key.endsWith(':snapshots'));
globalThis.localStorage = throwingStorage;
seedJson('mtc:items', [{ item_name: 'Legacy Kept' }]);
seedJson('mtc:snapshots', [{ id: 'snap_legacy', items: [] }]);
store = await loadStore(throwingStorage);
assert.doesNotThrow(() => store.loadItems());
assert.equal(store.isMigrationDeferred(), true);
assert.deepEqual(store.loadItems(), [{ item_name: 'Legacy Kept' }]);
store.saveItems([{ item_name: 'Saved During Defer' }]);
assert.equal(localStorage.getItem('mtc:schema'), null);
assert.equal(localStorage.getItem('mtc:characters'), null);
assert.equal(localStorage.getItem('mtc:active-char'), null);
assert.deepEqual(characterKeysInStorage(), []);
assert.deepEqual(JSON.parse(localStorage.getItem('mtc:items')), [{ item_name: 'Saved During Defer' }]);

throwingStorage.shouldThrow = () => false;
store = await loadStore(throwingStorage);
assert.equal(store.isMigrationDeferred(), false);
assert.deepEqual(store.loadItems(), [{ item_name: 'Saved During Defer' }]);
assert.equal(localStorage.getItem('mtc:schema'), '3');
assert.equal(localStorage.getItem('mtc:items'), null);
assert.equal(characterKeysInStorage().filter((key) => key.endsWith(':items')).length, 1);

store = await loadStore();
const exportCharA = store.listCharacters()[0];
store.renameCharacter(exportCharA.id, 'Export A');
store.setCharacterClass(exportCharA.id, 'Hero');
store.saveItems([{ item_name: 'Exported Item' }]);
store.saveScouter({ slot: '3', values: { str: '123' } });
store.saveFlameSettings({ mainStat: 'STR' });
store.saveSnapshot('Exported Snapshot', [{ item_name: 'Exported Item' }]);
const exportCharB = store.createCharacter({ name: 'Export B', class: 'Bishop' });
store.setActiveCharacter(exportCharB.id);
store.saveItems([{ item_name: 'Second Exported Item' }]);
const exported = JSON.parse(store.exportAll());
assert.equal(exported.version, 3);
assert.equal(exported.characters.length, 2);
assert.deepEqual(exported.characters.find((c) => c.id === exportCharA.id).items, [{ item_name: 'Exported Item' }]);
assert.deepEqual(exported.characters.find((c) => c.id === exportCharA.id).scouter, { slot: '3', values: { str: '123' } });
assert.deepEqual(exported.characters.find((c) => c.id === exportCharA.id).flame_settings, { mainStat: 'STR' });

store = await loadStore();
const original = store.listCharacters()[0];
store.saveItems([{ item_name: 'Original Item' }]);
store.saveFlameSettings({ mainStat: 'STR', attackWeight: 7.5 });
const v2Summary = store.importAll(JSON.stringify({
  version: 2,
  items: [{ item_name: 'Imported V2' }],
  snapshots: [{ id: 'snap_v2', items: [] }],
  flame_settings: { mainStat: 'DEX' },
}), true);
assert.equal(v2Summary.characters, 1);
assert.equal(store.listCharacters().some((c) => c.id === original.id), true);
assert.deepEqual(JSON.parse(localStorage.getItem(characterKey(original.id, 'items'))), [{ item_name: 'Original Item' }]);
assert.deepEqual(store.loadItems(), [{ item_name: 'Imported V2' }]);
assert.equal(store.setActiveCharacter(original.id), true);
assert.deepEqual(store.loadFlameSettings(), { mainStat: 'STR', attackWeight: 7.5 });

const v2NoItemsSummary = store.importAll(JSON.stringify({
  version: 2,
  snapshots: [{ id: 'snap_only', items: [] }],
  flame_settings: { mainStat: 'INT' },
}), true);
assert.equal(v2NoItemsSummary.characters, 1);
assert.deepEqual(store.loadItems(), []);
assert.deepEqual(store.listSnapshots().map((s) => s.id), ['snap_only']);
assert.deepEqual(store.loadFlameSettings(), { mainStat: 'INT' });
assert.equal(store.setActiveCharacter(original.id), true);
assert.deepEqual(store.loadFlameSettings(), { mainStat: 'STR', attackWeight: 7.5 });

store = await loadStore();
const mergeA = store.listCharacters()[0];
store.renameCharacter(mergeA.id, 'Merge A');
store.setCharacterClass(mergeA.id, 'Hero');
store.saveItems([{ item_name: 'Base Item' }]);
store.saveScouter({ slot: '3', values: { level: '285', bossDmg: '350' } });
store.saveFlameSettings({ mainStat: 'STR', attackWeight: 7.5 });
store.saveSnapshot('Base Snapshot', [{ item_name: 'Base Item' }]);
const baseSnap = store.listSnapshots()[0];
const mergeSummary = store.importAll(JSON.stringify({
  version: 3,
  characters: [
    {
      id: mergeA.id,
      name: 'Merge A Renamed',
      class: null,
      items: [{ item_name: 'Merged Item' }],
      snapshots: [baseSnap, { id: 'snap_new', name: 'New Snapshot', items: [] }],
      scouter: { slot: '2', values: { dex: '456' } },
      flame_settings: { mainStat: 'DEX', attackWeight: 4 },
    },
    {
      id: 'external_char',
      name: 'External',
      class: null,
      items: [{ item_name: 'External Item' }],
      snapshots: [],
    },
  ],
  userbank: { abc: 'あ' },
}), true);
assert.equal(mergeSummary.characters, 1);
assert.equal(mergeSummary.items, 2);
assert.equal(mergeSummary.snapshots, 1);
assert.deepEqual(store.listCharacters().find((c) => c.id === mergeA.id), {
  id: mergeA.id, name: 'Merge A Renamed', class: 'Hero',
});
assert.equal(store.setActiveCharacter(mergeA.id), true);
assert.deepEqual(store.loadItems(), [{ item_name: 'Base Item' }, { item_name: 'Merged Item' }]);
assert.deepEqual(store.listSnapshots().map((s) => s.id), [baseSnap.id, 'snap_new']);
assert.deepEqual(store.loadScouter(), { slot: '3', values: { level: '285', bossDmg: '350' } });
assert.deepEqual(store.loadFlameSettings(), { mainStat: 'STR', attackWeight: 7.5 });
assert.deepEqual(store.loadUserBank(), { abc: 'あ' });
assert.ok(store.listCharacters().some((c) => c.id === 'external_char'));

store = await loadStore();
const emptyMerge = store.listCharacters()[0];
const emptyMergeSummary = store.importAll(JSON.stringify({
  version: 3,
  characters: [{
    id: emptyMerge.id,
    name: 'Empty Merge',
    class: 'Paladin',
    items: [],
    snapshots: [],
    scouter: { slot: '2', values: { dex: '456' } },
    flame_settings: { mainStat: 'DEX', attackWeight: 4 },
  }],
}), true);
assert.equal(emptyMergeSummary.updated, 1);
assert.deepEqual(store.listCharacters().find((c) => c.id === emptyMerge.id), {
  id: emptyMerge.id, name: 'Empty Merge', class: 'Paladin',
});
assert.deepEqual(store.loadScouter(), { slot: '2', values: { dex: '456' } });
assert.deepEqual(store.loadFlameSettings(), { mainStat: 'DEX', attackWeight: 4 });

const deferredExportStorage = new ThrowingStorage((key) => key.startsWith('mtc:char:') && key.endsWith(':items'));
globalThis.localStorage = deferredExportStorage;
seedJson('mtc:items', [{ item_name: 'Deferred Export' }]);
store = await loadStore(deferredExportStorage);
assert.doesNotThrow(() => store.exportAll());
assert.equal(store.isMigrationDeferred(), true);

console.log('store: OK');
