# 転生更新チェックの計算仕様

確認日: 2026-08-01

## 対象と目的

OCRで取得済みの `str_bonus`、`dex_bonus`、`int_bonus`、`luk_bonus`、`all_stats_pct_bonus`、`attack_power_bonus`、`magic_att_bonus` を換算スコアにし、同じ装備IL・ボス転生区分で得られるスコアの確率分布と比較する。

現時点では通常職の非武器のみを対象とする。武器は基礎ATT/MATT、Xenonは複数主ステ、Demon AvengerはHPを含む専用評価が必要なため順位から除外する。

## 計算

初期設定は次の参考換算式を使う。

`主ステ転生 + 副ステ転生 × 0.1 + ALL Stats %転生 × 10 + ATT/MATT転生 × 4`

係数は公式仕様ではなく、ユーザーが画面から変更できる参考値である。主ステと副ステは同じ項目にできない。ILには装備レベル低下後の表示値ではなく `req_level_base ?? req_level` を使う。

確率分布は、対象部位に付く各オプションを等確率、各ラインのTierを素材別確率として計算する。現在スコアが分布のどこにあるかを求め、次の区分で弱い順に並べる。

- 80%未満: 最優先
- 80%以上95%未満: 更新候補
- 95%以上99%未満: 平均以上
- 99%以上99.9%未満: 良好
- 99.9%以上: 最高水準

少しでもスコアが更新される1回あたりの確率と、更新までに必要な平均個数は次式で求める。同点は更新に含めない。

`更新確率 = P(再抽選スコア > 現在スコア)`

`平均個数 = 1 / 更新確率`

更新確率が0の場合は「到達不可」と表示する。各試行が独立で、現在スコアを更新目標として維持できる前提の期待値であり、必要個数を保証する値ではない。

ボス転生の有無はILから推測しない。既知の装備名に一致した場合のみ「推定」と表示し、それ以外はユーザー指定が完了するまで判定を保留する。

自動推定する既知名には、Root Abyss防具（Royal帽子、Eagle Eye上衣、Trixter下衣）、Arcane Umbra、Eternal、および次のボスアクセサリを含む。

- Pitched Boss Set（漆黒）: Berserked、Magic Eyepatch、Source of Suffering、Cursed各色Spellbook、Commanding Force Earring、Dreamy Belt
- Brilliant Boss Set（光輝）: Original Sin of Pride、Oath of Death

Pitched Boss SetのRing、Android Heart、Badge、Emblem、およびBrilliant Boss SetのRingとMedalは、本ツールの転生対象外部位に該当するため名前推定へ追加しない。

素材に関係なく追加オプションTierが固定される特殊装備は標準分布で評価できない。転生区分で「特殊固定Tier (対象外)」を指定し、確率判定から除外する。

## データと出典

- `data/flame_tier_probabilities.csv`: 強力、永遠／黒い転生素材のTier確率
- `data/flame_line_probabilities.csv`: 通常装備の付与ライン数とボス装備の4ライン固定
- `js/flame.js`: 非武器で使うIL帯別ステータス値の規則と確率分布計算

既知GMS名と部位は、[Root Abyss](https://maplestorywiki.net/w/Root_Abyss)、[Pitched Boss Set](https://maplestorywiki.net/w/Pitched_Boss_Set)、[Brilliant Boss Set](https://maplestorywiki.net/w/Brilliant_Boss_Set)の装備一覧で確認した（確認日: 2026-08-01）。

確率、ボス装備のTier +2、4ライン固定、候補オプションの等確率、ATT/MATTとALL Stats %の最低ILは[KMS公式「追加オプション」](https://maplestory.nexon.com/Guide/OtherProbability/game/gameAddOption)を基準にしている。IL帯別のステータス値は公開されているゲーム仕様を数式化し、第三者Wikiの表そのものはリポジトリへ収録しない。

このツールは英語版GMSのツールチップを対象としているが、上記確率モデルが現在のGMSと完全に同じかは未確認である。そのため画面にもKMS基準であることを表示し、判定は参考値として扱う。

KMS公式仕様では、追加オプション再設定後の結果が現在と完全に同一の場合は再抽選される。本ツールのOCRデータからは元のオプション種類とTierの組合せを一意に復元できないため、この条件付き再抽選は分布に反映せず、独立した1回分の結果として近似する。

## 保存と互換性

ボス転生の手動指定は装備データの `flame_advantaged` に真偽値、特殊固定Tierの対象外指定は同じ項目に `"fixed"` として保存する。換算係数はlocalStorageの `mtc:flame-settings` に保存する。JSONエクスポートはこれらを含み、旧形式のJSONを読み込んだ場合は既定値で補完する。

ALL Stats %の既定値を15から10へ変更した版では、旧形式の保存値が15のときだけ新しい既定値10へ移行する。それ以外のユーザー設定値は維持する。
