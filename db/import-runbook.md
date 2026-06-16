# Corporation D1 取込 runbook(WS-2 provisioning + WS-4 データ投入)

6/29 リリース時に法人データを D1 へ投入する手順。取込ロジックは
`src/core/bulk-import.ts`(テスト済み・infra 非依存)に集約済みで、本 runbook は
provisioning とデータ流し込みの実行手順のみを定義する。

> 親 §0: `wrangler deploy` は禁止(deploy は GitHub Actions)。本 runbook の
> `wrangler d1` 系は**データ層 provisioning / 取込専用**で deploy ではない。
> KV/D1 への remote 操作は `--remote` 必須(memory `reference_wrangler_kv_remote`)。

---

## 前提データ(国税庁 法人番号公表サイト)

- 主経路: **月次全件 CSV**(都道府県別 47 ファイル、ヘッダ無し・30 列・UTF-8)+ **日次差分 CSV**
- 列レイアウト: WS-1 実測(`../shirabe-assets/knowledge/20260530-corporation-api-ws1-fulldata-measurement.md`)
- 規模: 全国 ~540 万社 / 展開後 ~1.17GB → D1 10GB/DB 上限に余裕

## WS-2: D1 provisioning(初回のみ、経営者承認後)

```bash
# 1) DB 作成 → database_id を取得
npx wrangler d1 create shirabe-corporation

# 2) wrangler.toml の [[d1_databases]] ブロックを uncomment し database_id を設定
#    binding = "CORP_DB" / database_name = "shirabe-corporation"

# 3) schema(DDL + index)を本番へ適用
npx wrangler d1 execute shirabe-corporation --remote --file db/schema.sql
```

## WS-4: データ投入

取込エンジンは `src/core/bulk-import.ts`:

- `recordsFromCsv(text)` … 引用符対応 tokenize → `CorporationRecord[]`(既定で最新履歴のみ)
- `buildUpsertBatches(records, importedAt, batchSize)` … 冪等 upsert
  (`INSERT ... ON CONFLICT(law_id) DO UPDATE`)を `db.batch()` 単位の chunk に分割

実行系は **admin import endpoint**(`POST /api/v1/corporation/admin/import`、実装済み)。
`X-Admin-Token` ヘッダを Secret `ADMIN_IMPORT_TOKEN` と定数時間比較し、body の CSV 全文を
`recordsFromCsv` → `buildUpsertBatches` → `db.batch()` で投入する。

> ★★★ **大規模県は 1 POST 不可**(6/29 最大リスク): endpoint は `c.req.text()` で body
> 全文をメモリ展開し、全 record + 全 upsert statement を同時に保持する。Workers の
> 1 リクエスト 128MB メモリ + ボディ上限(plan により ~100MB)に対し、東京都など
> 大規模県の県別ファイル(数十〜百 MB)をそのまま POST すると **OOM / 413** になる。
> → **record 境界で小さく分割してから投入する**(下記 driver が自動化)。

#### 推奨: 投入 driver(`scripts/import-corporations.mjs`)

```bash
# Secret 注入(WS-4 投入前、初回のみ)
npx wrangler secret put ADMIN_IMPORT_TOKEN

# 1) dry-run(POST せず: 各ファイルのサイズ・推定 record 数・分割 chunk 数を出す)
node scripts/import-corporations.mjs --dir ./nta-csv --dry-run

# 2) 本投入(token は環境変数で渡す。引数に平文を書かない)
ADMIN_IMPORT_TOKEN=*** node scripts/import-corporations.mjs \
  --dir ./nta-csv --endpoint https://shirabe.dev/api/v1/corporation/admin/import
```

driver の挙動:
- `--dir` 内の `*.csv` を **名前昇順(= 県コード順)** で順次処理
- 各ファイルを **record 境界(引用符内改行を壊さない)** で `--max-bytes`(既定 8MiB)以下の
  chunk に貪欲分割 → chunk ごとに POST
- POST は 5xx / ネットワーク失敗で指数バックオフ・リトライ(4xx は即停止)
- **冪等**: upsert 収束のため中断後の再実行・同一ファイル再投入が安全
- 分割ロジック(`splitIntoChunks` / `recordSpans`)は `test/import-corporations.test.ts` で
  ロスレス結合・境界安全・byte 上限を回帰検証済み

#### 低レベル(単一ファイルを直接 POST、小ファイルのみ)

```bash
curl -X POST https://shirabe.dev/api/v1/corporation/admin/import \
  -H "X-Admin-Token: <token>" \
  --data-binary @02_aomori.csv
# → { "imported": N, "skipped": M, "batches": B, "importedAt": "..." }
```

レスポンスコード: 200(投入成功)/ 400(空 body)/ 401(トークン不正)/
503(`ADMIN_IMPORT_TOKEN` 未設定 = `ADMIN_DISABLED`、または CORP_DB 未 provisioning)。

### 運用フロー

1. 月次全件: 47 ファイルを driver で順次投入(各ファイル内は最新履歴のみ採用)
2. 日次差分: 差分 CSV を同 driver / endpoint へ POST(latest=1 行が既存を upsert で置換)
3. 冪等性: 同一ファイル再投入は安全(law_id 競合で UPDATE に収束)

### 投入前の検証(dry-run、binding 不要)

```bash
# 実ファイルのサイズ・record 数・分割数を一覧(POST しない)
node scripts/import-corporations.mjs --dir ./nta-csv --dry-run

# tokenizer / upsert / chunk + 分割 driver の回帰
npm run test -- bulk-import
npm run test -- import-corporations
```

列整合の深い検証は `recordsFromCsv(fs.readFileSync(path,'utf8'), { onError })` を
一時テストで評価する(onError で列数不正行を観測)。

---

## まだ未実装(6/29 wiring で対応)

- [x] ~~admin import endpoint(Secret 認証 + 投入ループ)~~ 実装済み(`/api/v1/corporation/admin/import`)
- [x] ~~投入 driver(47 県順次 + record 境界分割 + dry-run + リトライ)~~ 実装済み(`scripts/import-corporations.mjs`、`npm run import:corp`)
- [x] ~~Free 枠 quota 決定 + 429/license_recommend middleware~~ 実装済み(2026-06-15 サインオフ = 住所クラス
      Free 5,000 / ¥0.5・0.3・0.1。`middleware/plan-pricing.ts` + `usage-check.ts`、scaffold)。
- [x] ~~auth middleware(共有 API_KEYS namespace から per-request key + Hub license 解決)+ routes 適用~~
      実装済み(2026-06-16 ① 共有サインオフ。`middleware/auth.ts` + `core/license.ts` + `middleware/api-key.ts`、
      metered routes = validate/lookup/search/normalize/batch に auth→usage-check 適用、health/admin は対象外。
      `wrangler.toml` の API_KEYS binding 有効化。**API_KEYS 未 binding / USAGE_LOGS 未 provisioning の間は inert**)
- [ ] **残(6/29 wiring)**: USAGE_LOGS(corp 専用 namespace)provisioning + usage-logger 増分 + Stripe metering
- [ ] OpenAPI/llms.txt 配信(live 後・staged、live 前は虚偽のため未公開)
