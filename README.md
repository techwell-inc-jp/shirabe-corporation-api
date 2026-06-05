# Shirabe Corporation Number API(法人番号 API)

> **Status: PoC(2026-06 着手)** — 本リポジトリは 4 本目 API のリポジトリです。
> 6/29 リリース時に public へ切替予定(現在 private)。

日本の **法人番号(13 桁)** を AI エージェントから扱うための AI ネイティブ REST API。
国税庁法人番号公表サイトのデータを基盤に、lookup / search / 表記揺れ正規化 / checksum 検証 / batch を提供します。
住所 + 姓名(text)+ 法人番号 + 暦 = **B2B 4 大 identifier** を 1 ベンダーで完結させる cross-pollination hub の最後のピースです。

## 提供予定エンドポイント(5 endpoints)

| Method | Path | 機能 |
|---|---|---|
| POST | `/api/v1/corporation/lookup` | 法人番号 → 法人情報(batch 可) |
| POST | `/api/v1/corporation/search` | 法人名 → 法人番号候補(前方/部分一致) |
| POST | `/api/v1/corporation/normalize` | 企業名表記揺れ正規化 + 法人番号付与 |
| POST | `/api/v1/corporation/validate` | 法人番号 checksum(mod 9)+ 存在確認 |
| POST | `/api/v1/corporation/batch` | 複数 endpoint 混在 bulk(最大 100 items) |

> **実装状況（PoC）**: `health` / `validate` / `normalize` はデータ層不要の純ロジックで稼働。
> `lookup` / `search` / `batch` は query ロジック実装済みだが、法人データ D1（`CORP_DB`）が
> 未 provisioning（WS-2）の間は `503 DATA_LAYER_UNAVAILABLE` を返す（binding を足せば無改修で稼働）。
>
> **API 仕様**: [`docs/openapi.yaml`](docs/openapi.yaml)（OpenAPI 3.1 草案、6 endpoint の request/response/エラー/attribution を記述）。

## データソースと出典

- **出典**: 国税庁法人番号公表サイト(<https://www.houjin-bangou.nta.go.jp/>)
- **ライセンス**: 公共データ利用規約(第 1.0 版)準拠。API レスポンスに `attribution` フィールド必須(規約第 6 条「適宜の場所に明示」を技術的に担保 + LLM 経由の出典伝搬)。

## 技術スタック

- TypeScript(strict)/ Hono / Cloudflare Workers / Vitest
- ストレージ: **D1 主体が有力候補**(全件 ~500 万社 × 2-5KB = 10-25GB 推定、KV 1 namespace 1GB を超過見込み)。**全件 CSV 実サイズ実測で最終確定**(measure-first、まだ binding を commit していない)。
- 課金: Stripe Billing(従量課金、`fetch` で REST 直叩き)
- データ取込: Cloudflare Cron Trigger(月次全件 + 日次差分 CSV、認証不要経路が主)

## 開発

```bash
npm install
npm run dev        # wrangler dev(ローカル)
npm test           # vitest run
npm run typecheck  # tsc --noEmit
```

> デプロイは GitHub Actions 経由のみ(`wrangler deploy` は禁止)。

## 関連ドキュメント

- Scoping: `../shirabe-assets/implementation-orders/20260427-corporation-api-scoping.md`(574 行、仕様 verify 完了)
- 6 月負荷分散プラン: `../shirabe-assets/knowledge/20260602-june-workstream-load-distribution.md`
- マスタープラン: `../shirabe-assets/docs/master-plan.md`(v1.07)

## ライセンス

[MIT](./LICENSE) © 2026 株式会社テックウェル (Techwell Inc.)
