// maplescouter.com 連携: フォーム値 → localStorage差分 → 使い捨てブックマークレット
//
// 同一オリジンポリシーによりこのサイトから maplescouter.com の localStorage は触れない。
// そこで「差分データを焼き込んだブックマークレット」を毎回生成し、
// ユーザーがブックマークバーへドラッグ → 向こうのサイトで実行してもらう方式をとる。
// クリップボードAPI不要なのでFirefoxでも許可ダイアログが出ない。

// maplescouter側 localStorage: キー名 'preset' / Zustand persist形式
//   {"state":{"preset":{"1":{"data":{"stat":{...}}}}},"version":0}
export const PRESET_KEY = 'preset';
export const SLOTS = ['1', '2', '3'];

// key は maplescouter の state.preset[N].data.stat 内のキー名。
// group: 'char'=手入力必須 / 'stat'=STATウィンドウ / 'popup'=ステータスのオンマウス詳細
export const SCOUTER_FIELDS = [
  { key: 'level', label: 'レベル', unit: '', group: 'char', hint: 'STAT画面の数値ではなくキャラLv' },

  { key: 'dmg', label: 'ダメージ', unit: '%', group: 'stat', hint: 'DAMAGE' },
  { key: 'bossDmg', label: 'ボスダメージ', unit: '%', group: 'stat', hint: 'BOSS DAMAGE' },
  { key: 'normalDmg', label: '通常モンスターダメージ', unit: '%', group: 'stat', hint: 'NORMAL MONSTER DAMAGE' },
  { key: 'ignoreDef', label: '防御率無視', unit: '%', group: 'stat', hint: 'IGNORE DEFENSE' },
  { key: 'critical', label: 'クリティカル確率', unit: '%', group: 'stat', hint: 'CRITICAL RATE' },
  { key: 'criticalDmg', label: 'クリティカルダメージ', unit: '%', group: 'stat', hint: 'CRITICAL DAMAGE' },
  { key: 'coolTimeReduce', label: 'クールタイム減少(秒)', unit: '秒', group: 'stat', hint: 'COOLDOWN REDUCTION の「N sec」側' },
  { key: 'coolTimeReducePercent', label: 'クールタイム減少(%)', unit: '%', group: 'stat', hint: '同じ行の「M%」側' },
  { key: 'resetCoolDown', label: 'クールタイムリセット', unit: '%', group: 'stat', hint: 'COOLDOWN RESET' },
  { key: 'buffDuration', label: 'バフ持続時間', unit: '%', group: 'stat', hint: 'BUFF DURATION' },
  { key: 'ignoreElementalResist', label: '属性耐性無視', unit: '%', group: 'stat', hint: 'IGNORE ELEMENTAL RESISTANCE' },
  { key: 'statusAdditionalDmg', label: '状態異常追加ダメージ', unit: '%', group: 'stat', hint: 'ABNORMAL STATUS DAMAGE' },
  { key: 'summonPersistTime', label: '召喚獣持続時間', unit: '%', group: 'stat', hint: 'SUMMON DURATION' },
  { key: 'arcaneForce', label: 'アーケインフォース', unit: '', group: 'stat', hint: 'ARCANE FORCE' },
  { key: 'authenticForce', label: 'オーセンティックフォース', unit: '', group: 'stat', hint: 'AUTHENTIC FORCE' },

  { key: 'mainStatBase', label: 'メインステ 素', unit: '', group: 'popup', hint: 'ポップアップの「AP+装備前」相当の基本値' },
  { key: 'mainStatPer', label: 'メインステ 増加率', unit: '%', group: 'popup', hint: '' },
  { key: 'mainStatAbs', label: 'メインステ 固定加算', unit: '', group: 'popup', hint: '' },
  { key: 'subStatBase', label: 'サブステ 素', unit: '', group: 'popup', hint: '' },
  { key: 'subStatPer', label: 'サブステ 増加率', unit: '%', group: 'popup', hint: '' },
  { key: 'subStatAbs', label: 'サブステ 固定加算', unit: '', group: 'popup', hint: '' },
  { key: 'atkBase', label: '攻撃力/魔力 素', unit: '', group: 'popup', hint: '魔法職は魔力側を入力' },
  { key: 'atkPercent', label: '攻撃力/魔力 増加率', unit: '%', group: 'popup', hint: '' },
  { key: 'atkAbs', label: '攻撃力/魔力 固定加算', unit: '', group: 'popup', hint: '' },
];

export const GROUP_LABELS = {
  char: 'キャラクター',
  stat: 'STATウィンドウ',
  popup: 'ステータス詳細(オンマウス)',
};

const FIELD_KEYS = SCOUTER_FIELDS.map((f) => f.key);

// "1,234" / "12%" / "＋3１" のような入力を数値へ。数値化できなければ null
export function toNumber(raw) {
  if (raw === null || raw === undefined) return null;
  const s = String(raw)
    .replace(/[０-９．＋－]/g, (c) => '0123456789.+-'['０１２３４５６７８９．＋－'.indexOf(c)])
    .replace(/[,\s%+秒]/g, '');
  if (s === '' || s === '-' || s === '.') return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// フォーム値 → 疎な差分オブジェクト。
// 空欄・数値化不能のキーは「含めない」= 向こうの既存値(myClass等)を壊さない
export function buildDiff(values) {
  const diff = {};
  for (const key of FIELD_KEYS) {
    const n = toNumber(values?.[key]);
    if (n !== null) diff[key] = n;
  }
  return diff;
}

// ブックマークレットが行うマージのNode側参照実装(テスト用)。presetRootを破壊的に更新する
export function applyDiff(presetRoot, slot, diff) {
  const preset = presetRoot?.state?.preset;
  if (!preset || typeof preset !== 'object') return { error: 'no-preset' };
  const entry = preset[String(slot)];
  if (!entry || typeof entry !== 'object') return { error: 'no-slot' };
  const stat = entry.data?.stat;
  if (!stat || typeof stat !== 'object') return { error: 'no-stat' };
  Object.assign(stat, diff);
  return { root: presetRoot, stat };
}

const MSG = {
  host: 'このボタンは maplescouter.com のページで押してください。\nhttps://maplescouter.com/ja/input を開いてから、もう一度クリックしてください。',
  empty: 'maplescouterの保存データが見つかりません。\n先にmaplescouterで一度なにか入力して(値が保存された状態にして)から、もう一度クリックしてください。',
  broken: 'maplescouterの保存データを読み取れませんでした。データ形式が変わった可能性があります。',
  slot: 'プリセット%s のデータが見つかりません。\nmaplescouter側でプリセット%s を一度開いて入力してから、もう一度クリックしてください。',
};

// 実際にブックマークレットとして動くコード本体(javascript: を付ける前の生テキスト)。
// 埋め込みは JSON.stringify 経由のみ = 文字列エスケープ安全。
// localStorage / location / alert はグローバル参照のみ(テストで new Function に差し替え可能)
export function buildBookmarkletCode(diff, slot) {
  const d = JSON.stringify(diff);
  const n = JSON.stringify(String(slot));
  const m = (s) => JSON.stringify(s.replace(/%s/g, String(slot)));
  return [
    '(function(){',
    'try{',
    `if(!/(^|\\.)maplescouter\\.com$/.test(location.hostname)){alert(${m(MSG.host)});return;}`,
    `var K=${JSON.stringify(PRESET_KEY)},raw=localStorage.getItem(K);`,
    `if(!raw){alert(${m(MSG.empty)});return;}`,
    'var o=null;',
    'try{o=JSON.parse(raw);}catch(e){o=null;}',
    `if(!o||!o.state||!o.state.preset){alert(${m(MSG.broken)});return;}`,
    `var p=o.state.preset[${n}],st=p&&p.data&&p.data.stat;`,
    `if(!st||typeof st!=='object'){alert(${m(MSG.slot)});return;}`,
    `Object.assign(st,${d});`,
    'localStorage.setItem(K,JSON.stringify(o));',
    'location.reload();',
    '}catch(e){alert(' + JSON.stringify('反映に失敗しました: ') + '+e);}',
    '})();',
  ].join('');
}

// <a href> にそのまま入れられる形。ドラッグでブックマーク化して使う
export function buildBookmarklet(diff, slot) {
  return 'javascript:' + encodeURIComponent(buildBookmarkletCode(diff, slot));
}
