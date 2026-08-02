// localStorage 永続化・スナップショット・エクスポート/インポート
const K_ITEMS = 'mtc:items';
const K_SNAPSHOTS = 'mtc:snapshots';
const K_USERBANK = 'mtc:userbank';
const K_SCOUTER = 'mtc:scouter';
const K_FLAME_SETTINGS = 'mtc:flame-settings';
const K_PLAN_ALL_STEPS = 'mtc:plan-all-steps';
const K_CHARACTERS = 'mtc:characters';
const K_ACTIVE_CHAR = 'mtc:active-char';
const K_SCHEMA = 'mtc:schema';
const SCHEMA_VERSION = 3;

const CHARACTER_OWNED_KEYS = [
  ['items', K_ITEMS],
  ['snapshots', K_SNAPSHOTS],
  ['scouter', K_SCOUTER],
  ['flame-settings', K_FLAME_SETTINGS],
];
const LEGACY_KEYS_BY_SUFFIX = Object.fromEntries(CHARACTER_OWNED_KEYS);

let lastCharacterIdMs = 0;
let lastCharacterIdSeq = 0;
let migrationDeferred = false;

function load(key, fallback) {
  try {
    const s = localStorage.getItem(key);
    return s ? JSON.parse(s) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, val) {
  localStorage.setItem(key, JSON.stringify(val));
}

function charKey(id, suffix) {
  return `mtc:char:${id}:${suffix}`;
}

function characterKeys(id) {
  return CHARACTER_OWNED_KEYS.map(([suffix]) => charKey(id, suffix));
}

function storageKeyExists(key) {
  return localStorage.getItem(key) !== null;
}

function characterIdExists(id) {
  if (readCharactersRaw().some((c) => c.id === id)) return true;
  return characterKeys(id).some(storageKeyExists);
}

function makeCharacterId() {
  let id;
  do {
    const now = Date.now();
    if (now === lastCharacterIdMs) {
      lastCharacterIdSeq += 1;
    } else {
      lastCharacterIdMs = now;
      lastCharacterIdSeq = 0;
    }
    id = lastCharacterIdSeq ? `char_${now}_${lastCharacterIdSeq}` : `char_${now}`;
  } while (characterIdExists(id));
  return id;
}

function readCharactersRaw() {
  const chars = load(K_CHARACTERS, []);
  return Array.isArray(chars) ? chars : [];
}

function writeCharacters(chars) {
  save(K_CHARACTERS, chars);
}

function defaultCharacter() {
  return { id: makeCharacterId(), name: 'キャラ1', class: null };
}

function snapshotKeys(keys) {
  return new Map(keys.map((key) => [key, localStorage.getItem(key)]));
}

function restoreKeys(snapshot) {
  for (const [key, value] of snapshot) {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  }
}

function removeKeys(keys) {
  for (const key of keys) localStorage.removeItem(key);
}

function legacyKeyForSuffix(suffix) {
  return LEGACY_KEYS_BY_SUFFIX[suffix];
}

function loadForCharacter(id, suffix, fallback) {
  return load(charKey(id, suffix), fallback);
}

function saveForCharacter(id, suffix, value) {
  save(charKey(id, suffix), value);
}

function deferMigration() {
  migrationDeferred = true;
}

function migrateStorage() {
  if (migrationDeferred || localStorage.getItem(K_SCHEMA) === String(SCHEMA_VERSION)) return;

  const character = defaultCharacter();
  const newKeys = [];
  const metaKeys = [K_CHARACTERS, K_ACTIVE_CHAR, K_SCHEMA];
  const previousMeta = snapshotKeys(metaKeys);

  try {
    // 旧キーは容量対策のため最終的に消すが、コピー完了とメタ情報の書き込みが終わるまでは原本として残す。
    // 途中で QuotaExceededError などが起きた場合は、この起動中だけ旧キーを直接読む縮退運転へ落とす。
    for (const [suffix, oldKey] of CHARACTER_OWNED_KEYS) {
      const oldValue = localStorage.getItem(oldKey);
      if (oldValue !== null) {
        const newKey = charKey(character.id, suffix);
        localStorage.setItem(newKey, oldValue);
        newKeys.push(newKey);
      }
    }

    writeCharacters([character]);
    localStorage.setItem(K_ACTIVE_CHAR, character.id);
    localStorage.setItem(K_SCHEMA, String(SCHEMA_VERSION));
    for (const [, oldKey] of CHARACTER_OWNED_KEYS) localStorage.removeItem(oldKey);
  } catch {
    removeKeys(newKeys);
    restoreKeys(previousMeta);
    deferMigration();
  }
}

function ensureCharacterStorage() {
  if (migrationDeferred) return null;
  migrateStorage();
  if (migrationDeferred) return null;

  const active = localStorage.getItem(K_ACTIVE_CHAR);
  if (localStorage.getItem(K_SCHEMA) === String(SCHEMA_VERSION) && active) return active;

  let chars = readCharactersRaw();
  if (!chars.length) {
    const character = defaultCharacter();
    chars = [character];
    writeCharacters(chars);
    localStorage.setItem(K_ACTIVE_CHAR, character.id);
    return character.id;
  }
  if (!chars.some((c) => c.id === active)) {
    localStorage.setItem(K_ACTIVE_CHAR, chars[0].id);
    return chars[0].id;
  }
  return active;
}

function activeCharKey(suffix) {
  const characterId = ensureCharacterStorage();
  return characterId ? charKey(characterId, suffix) : legacyKeyForSuffix(suffix);
}

export function isMigrationDeferred() {
  return migrationDeferred;
}

export const loadItems = () => load(activeCharKey('items'), []);
export const saveItems = (items) => save(activeCharKey('items'), items);

export const loadUserBank = () => load(K_USERBANK, {});
export const saveUserBank = (glyphs) => save(K_USERBANK, glyphs);

// スカウター連携フォームの入力内容 { slot, values: {key: 文字列} }
export const loadScouter = () => load(activeCharKey('scouter'), { slot: '1', values: {} });
export const saveScouter = (form) => save(activeCharKey('scouter'), form);
export const loadFlameSettings = () => load(activeCharKey('flame-settings'), {});
export const saveFlameSettings = (settings) => save(activeCharKey('flame-settings'), settings);

// 強化プランの表示モード(true=同一装備の先の段階も全部出す)
export const loadPlanAllSteps = () => load(K_PLAN_ALL_STEPS, false) === true;
export const savePlanAllSteps = (on) => save(K_PLAN_ALL_STEPS, !!on);

export const listSnapshots = () => load(activeCharKey('snapshots'), []);

function saveSnapshots(snaps) {
  save(activeCharKey('snapshots'), snaps);
}

export function saveSnapshot(name, items) {
  const snaps = listSnapshots();
  snaps.push({ id: `snap_${Date.now()}`, name: name || '', ts: new Date().toISOString(), items });
  saveSnapshots(snaps);
  return snaps;
}

export function deleteSnapshot(id) {
  const snaps = listSnapshots().filter((s) => s.id !== id);
  saveSnapshots(snaps);
  return snaps;
}

export function getSnapshot(id) {
  return listSnapshots().find((s) => s.id === id) || null;
}

// ファイル退避用: 全データを1つのJSONに
export function exportAll() {
  const characters = listCharacters().map((character) => ({
    ...character,
    items: loadForCharacter(character.id, 'items', []),
    snapshots: loadForCharacter(character.id, 'snapshots', []),
    scouter: loadForCharacter(character.id, 'scouter', { slot: '1', values: {} }),
    flame_settings: loadForCharacter(character.id, 'flame-settings', {}),
  }));
  return JSON.stringify({
    version: 3,
    exported_at: new Date().toISOString(),
    characters,
    userbank: loadUserBank(),
  }, null, 1);
}

// 戻り値: 取り込んだ内容の概要。merge=true なら既存に足す(スナップショットはid重複スキップ)
export function importAll(jsonText, merge = true) {
  const data = JSON.parse(jsonText);
  if (!data || typeof data !== 'object') throw new Error('invalid json');
  const summary = {
    characters: 0,
    updated: 0,
    items: 0,
    snapshots: 0,
    userbank: 0,
    flame_settings: 0,
    activeCharacterId: null,
    activeCharacterName: null,
  };
  if (data.version === 3 && Array.isArray(data.characters)) {
    importV3(data, summary);
  } else {
    importV2(data, merge, summary);
  }
  if (data.userbank && typeof data.userbank === 'object') {
    const bank = { ...loadUserBank(), ...data.userbank };
    saveUserBank(bank);
    summary.userbank = Object.keys(data.userbank).length;
  }
  if (summary.activeCharacterId) setActiveCharacter(summary.activeCharacterId);
  return summary;
}

function importV2(data, merge, summary) {
  const character = createCharacter({ name: `インポート ${new Date().toLocaleString('ja-JP')}`, class: null });
  if (!character) return;
  const items = Array.isArray(data.items) ? data.items : [];
  const snapshots = Array.isArray(data.snapshots) ? data.snapshots : [];
  saveForCharacter(character.id, 'items', items);
  saveForCharacter(character.id, 'snapshots', snapshots);
  saveForCharacter(character.id, 'scouter', { slot: '1', values: {} });
  saveForCharacter(character.id, 'flame-settings', {});
  summary.characters = 1;
  summary.items = items.length;
  summary.snapshots = snapshots.length;
  summary.activeCharacterId = character.id;
  summary.activeCharacterName = character.name;
  if (data.flame_settings && typeof data.flame_settings === 'object') {
    saveForCharacter(character.id, 'flame-settings', data.flame_settings);
    summary.flame_settings = 1;
  }
}

function isEmptyObject(value) {
  return !value || typeof value !== 'object' || Array.isArray(value) || !Object.keys(value).length;
}

function isEmptyScouter(value) {
  return !value || typeof value !== 'object' || !Object.keys(value.values || {}).length;
}

function importV3(data, summary) {
  const chars = readCharactersRaw();
  const byId = new Map(chars.map((c) => [c.id, c]));
  for (const incoming of data.characters) {
    if (!incoming || typeof incoming !== 'object') continue;
    const id = String(incoming.id || '');
    let targetId = id && byId.has(id) ? id : null;
    if (!targetId) {
      targetId = id && !characterIdExists(id) ? id : makeCharacterId();
      const character = { id: targetId, name: incoming.name ?? '', class: incoming.class ?? null };
      chars.push(character);
      byId.set(targetId, character);
      writeCharacters(chars);
      summary.characters++;
      if (!summary.activeCharacterId) summary.activeCharacterId = targetId;
      if (!summary.activeCharacterName) summary.activeCharacterName = character.name;
    } else {
      const current = byId.get(targetId);
      current.name = incoming.name ?? current.name;
      current.class = current.class || incoming.class || null;
      writeCharacters(chars);
      summary.updated++;
    }

    if (Array.isArray(incoming.items)) {
      const merged = loadForCharacter(targetId, 'items', []).concat(incoming.items);
      saveForCharacter(targetId, 'items', merged);
      summary.items += incoming.items.length;
    }
    if (Array.isArray(incoming.snapshots)) {
      const snaps = loadForCharacter(targetId, 'snapshots', []);
      const seen = new Set(snaps.map((s) => s.id));
      for (const snap of incoming.snapshots) {
        if (!seen.has(snap.id)) {
          snaps.push(snap);
          summary.snapshots++;
        }
      }
      saveForCharacter(targetId, 'snapshots', snaps);
    }
    const currentScouter = loadForCharacter(targetId, 'scouter', { slot: '1', values: {} });
    if (incoming.scouter && typeof incoming.scouter === 'object' && isEmptyScouter(currentScouter)) {
      saveForCharacter(targetId, 'scouter', incoming.scouter);
    }
    const currentFlameSettings = loadForCharacter(targetId, 'flame-settings', {});
    if (incoming.flame_settings && typeof incoming.flame_settings === 'object' && isEmptyObject(currentFlameSettings)) {
      saveForCharacter(targetId, 'flame-settings', incoming.flame_settings);
      summary.flame_settings++;
    }
  }
}

export function listCharacters() {
  const id = ensureCharacterStorage();
  if (migrationDeferred) return [{ id: id || 'legacy', name: 'キャラ1', class: null }];
  return readCharactersRaw().map((c) => ({ id: c.id, name: c.name, class: c.class ?? null }));
}

export function getActiveCharacterId() {
  return ensureCharacterStorage() || 'legacy';
}

export function setActiveCharacter(id) {
  if (migrationDeferred) return false;
  migrateStorage();
  if (migrationDeferred || !readCharactersRaw().some((c) => c.id === id)) return false;
  localStorage.setItem(K_ACTIVE_CHAR, id);
  return true;
}

export function createCharacter({ name = '', class: className = null } = {}) {
  migrateStorage();
  if (migrationDeferred) return null;
  const character = { id: makeCharacterId(), name, class: className ?? null };
  writeCharacters(readCharactersRaw().concat(character));
  return character;
}

export function renameCharacter(id, name) {
  migrateStorage();
  if (migrationDeferred) return false;
  const chars = readCharactersRaw();
  const index = chars.findIndex((c) => c.id === id);
  if (index < 0) return false;
  chars[index] = { ...chars[index], name };
  writeCharacters(chars);
  return true;
}

export function setCharacterClass(id, className) {
  migrateStorage();
  if (migrationDeferred) return false;
  const chars = readCharactersRaw();
  const index = chars.findIndex((c) => c.id === id);
  if (index < 0) return false;
  chars[index] = { ...chars[index], class: className ?? null };
  writeCharacters(chars);
  return true;
}

export function deleteCharacter(id) {
  migrateStorage();
  if (migrationDeferred) return false;
  let chars = readCharactersRaw();
  if (!chars.some((c) => c.id === id)) return false;
  for (const key of characterKeys(id)) localStorage.removeItem(key);
  chars = chars.filter((c) => c.id !== id);
  if (!chars.length) chars = [defaultCharacter()];
  writeCharacters(chars);
  if (!chars.some((c) => c.id === localStorage.getItem(K_ACTIVE_CHAR))) {
    localStorage.setItem(K_ACTIVE_CHAR, chars[0].id);
  }
  return true;
}

export function characterStorageUsage() {
  migrateStorage();
  return listCharacters().map((character) => {
    let bytes = 0;
    let items = 0;
    let snapshots = 0;
    let scouterFields = 0;
    const keys = migrationDeferred ? Object.values(LEGACY_KEYS_BY_SUFFIX) : characterKeys(character.id);
    for (const key of keys) {
      const value = localStorage.getItem(key);
      if (value !== null) bytes += value.length * 2;
    }
    if (migrationDeferred) {
      items = load(K_ITEMS, []).length;
      snapshots = load(K_SNAPSHOTS, []).length;
      scouterFields = Object.keys(load(K_SCOUTER, { values: {} }).values || {}).length;
    } else {
      items = loadForCharacter(character.id, 'items', []).length;
      snapshots = loadForCharacter(character.id, 'snapshots', []).length;
      scouterFields = Object.keys(loadForCharacter(character.id, 'scouter', { values: {} }).values || {}).length;
    }
    return { ...character, bytes, items, snapshots, scouterFields };
  });
}
