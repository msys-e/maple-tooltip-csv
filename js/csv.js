// CSVスキーマ定義と生成
const STAT_BASES = [
  'str', 'dex', 'int', 'luk', 'max_hp', 'max_mp',
  'attack_power', 'magic_att', 'defense',
  'all_stats_pct', 'boss_damage_pct', 'ignore_def_pct',
];

export const COLUMNS = [
  'timestamp', 'item_name', 'star_count',
  ...STAT_BASES.flatMap((b) => [`${b}_total`, `${b}_base`, `${b}_star`, `${b}_bonus`]),
  'potential_grade',
  'pot1_text', 'pot1_grade', 'pot2_text', 'pot2_grade', 'pot3_text', 'pot3_grade',
  'extra_lines', 'raw_text',
];

function esc(v) {
  const s = v === undefined || v === null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function itemToRow(item) {
  return COLUMNS.map((c) => {
    if (c === 'extra_lines') return (item.extra_lines || []).join('|');
    return item[c];
  });
}

export function toCSV(items) {
  const rows = [COLUMNS.join(',')];
  for (const it of items) rows.push(itemToRow(it).map(esc).join(','));
  return '﻿' + rows.join('\r\n') + '\r\n';
}

export function downloadCSV(items, filename = null) {
  const name = filename || `maple_items_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.csv`;
  const blob = new Blob([toCSV(items)], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}
