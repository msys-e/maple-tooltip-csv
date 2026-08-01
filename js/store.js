// localStorage 永続化・スナップショット・エクスポート/インポート
const K_ITEMS = 'mtc:items';
const K_SNAPSHOTS = 'mtc:snapshots';
const K_USERBANK = 'mtc:userbank';
const K_SCOUTER = 'mtc:scouter';
const K_FLAME_SETTINGS = 'mtc:flame-settings';

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

export const loadItems = () => load(K_ITEMS, []);
export const saveItems = (items) => save(K_ITEMS, items);

export const loadUserBank = () => load(K_USERBANK, {});
export const saveUserBank = (glyphs) => save(K_USERBANK, glyphs);

// スカウター連携フォームの入力内容 { slot, values: {key: 文字列} }
export const loadScouter = () => load(K_SCOUTER, { slot: '1', values: {} });
export const saveScouter = (form) => save(K_SCOUTER, form);
export const loadFlameSettings = () => load(K_FLAME_SETTINGS, {});
export const saveFlameSettings = (settings) => save(K_FLAME_SETTINGS, settings);

export const listSnapshots = () => load(K_SNAPSHOTS, []);

export function saveSnapshot(name, items) {
  const snaps = listSnapshots();
  snaps.push({ id: `snap_${Date.now()}`, name: name || '', ts: new Date().toISOString(), items });
  save(K_SNAPSHOTS, snaps);
  return snaps;
}

export function deleteSnapshot(id) {
  const snaps = listSnapshots().filter((s) => s.id !== id);
  save(K_SNAPSHOTS, snaps);
  return snaps;
}

export function getSnapshot(id) {
  return listSnapshots().find((s) => s.id === id) || null;
}

// ファイル退避用: 全データを1つのJSONに
export function exportAll() {
  return JSON.stringify({
    version: 2,
    exported_at: new Date().toISOString(),
    items: loadItems(),
    snapshots: listSnapshots(),
    userbank: loadUserBank(),
    flame_settings: loadFlameSettings(),
  }, null, 1);
}

// 戻り値: 取り込んだ内容の概要。merge=true なら既存に足す(スナップショットはid重複スキップ)
export function importAll(jsonText, merge = true) {
  const data = JSON.parse(jsonText);
  if (!data || typeof data !== 'object') throw new Error('invalid json');
  const summary = { items: 0, snapshots: 0, userbank: 0, flame_settings: 0 };
  if (Array.isArray(data.items)) {
    const items = merge ? loadItems().concat(data.items) : data.items;
    saveItems(items);
    summary.items = data.items.length;
  }
  if (Array.isArray(data.snapshots)) {
    let snaps = merge ? listSnapshots() : [];
    const seen = new Set(snaps.map((s) => s.id));
    for (const s of data.snapshots) if (!seen.has(s.id)) { snaps.push(s); summary.snapshots++; }
    save(K_SNAPSHOTS, snaps);
  }
  if (data.userbank && typeof data.userbank === 'object') {
    const bank = merge ? { ...loadUserBank(), ...data.userbank } : data.userbank;
    saveUserBank(bank);
    summary.userbank = Object.keys(data.userbank).length;
  }
  if (data.flame_settings && typeof data.flame_settings === 'object') {
    saveFlameSettings(data.flame_settings);
    summary.flame_settings = 1;
  }
  return summary;
}
