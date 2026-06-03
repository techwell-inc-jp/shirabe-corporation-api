# CLAUDE.md — Shirabe Corporation Number API 固有ルール

このファイルは法人番号 API(`shirabe-corporation-api`)の固有ルール。
**親 `../CLAUDE.md`(Shirabe プロジェクト固有)→ その親 `../../CLAUDE.md`(全体共通)を
先に読んでから、本ファイルを適用すること。** 矛盾時は親(特に §0 セキュリティ)が優先。

---

## 1. プロダクト概要

- **プロダクト名**: Shirabe Corporation Number API(法人番号 API、4 本目)
- **リポジトリ**: `techwell-inc-jp/shirabe-corporation-api`(現在 **Private**、6/29 リリース時に Public 切替)
- **公開 URL**: `https://shirabe.dev`(共通ドメイン、`/api/v1/corporation/*` に振り分け)
- **状態**: **PoC(2026-06 着手)**。storage 確定 → scaffold → コア実装 → 6/29 リリース。
- **データ出典**: 国税庁法人番号公表サイト(公共データ利用規約 第 1.0 版)

## 2. 参照すべき基準ドキュメント

- **Scoping(最重要)**: `../shirabe-assets/implementation-orders/20260427-corporation-api-scoping.md`(574 行、国税庁仕様 verify 完了 + open questions §10)
- **6 月負荷分散プラン**: `../shirabe-assets/knowledge/20260602-june-workstream-load-distribution.md`
- **プロジェクト基準**: `../shirabe-assets/docs/project-guideline.md`
- **マスタープラン**: `../shirabe-assets/docs/master-plan.md`(v1.07)

## 3. アーキテクチャ方針(PoC で確定)

- ストレージ: **D1 主体が有力候補**(全件 ~500 万社、KV 1 namespace 1GB 超過見込み)。
  **全件 CSV 実サイズ実測で最終確定**(scoping §9.3 必須項目)。measure-first、未実測で binding を commit しない。
- データ取込: 主経路 = 月次全件 + 日次差分 CSV(認証不要)。副経路 = 国税庁 Web-API(アプリケーション ID 必要、KV miss 時のみ、HTTP 403 緩和)。
- 課金: Stripe Billing(`fetch` REST 直叩き、`stripe` npm 不使用)。

## 4. 固有の遵守事項

- レスポンスに **`attribution` フィールド必須**(規約第 6 条「適宜の場所に明示」+ LLM 経由出典伝搬)。編集加工時は `modified` + `modification_notice`。
- 国税庁 Web-API は短時間大量アクセス禁止(規約第 9 条)。副経路 call は per-customer rate limit + circuit breaker。
- パッケージマネージャは **npm**(`package-lock.json`、住所/text と同じ)。
- 親 §4: `wrangler deploy` 禁止(GitHub Actions 経由のみ)、KV `expiration_ttl` は `Math.max(60, ttl)`。
