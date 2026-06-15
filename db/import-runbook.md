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

```bash
# Secret 注入(WS-4 投入前、初回のみ)
npx wrangler secret put ADMIN_IMPORT_TOKEN

# 都道府県別ファイルを 1 つずつ POST(例: 青森県)
curl -X POST https://shirabe.dev/api/v1/corporation/admin/import \
  -H "X-Admin-Token: <token>" \
  --data-binary @02_aomori.csv
# → { "imported": N, "skipped": M, "batches": B, "importedAt": "..." }
```

レスポンスコード: 200(投入成功)/ 400(空 body)/ 401(トークン不正)/
503(`ADMIN_IMPORT_TOKEN` 未設定 = `ADMIN_DISABLED`、または CORP_DB 未 provisioning)。

### 運用フロー

1. 月次全件: 47 ファイルを順次 POST(各ファイル内は最新履歴のみ採用)
2. 日次差分: 差分 CSV を同 endpoint へ POST(latest=1 行が既存を upsert で置換)
3. 冪等性: 同一ファイル再 POST は安全(law_id 競合で UPDATE に収束)

### 投入前の検証(dry-run、binding 不要)

ダウンロードした CSV サンプルに対し、Vitest 環境で件数・列整合を確認できる:

```bash
npm run test -- bulk-import     # tokenizer / upsert / chunk の回帰
```

実ファイルのパース確認は `recordsFromCsv(fs.readFileSync(path,'utf8'), { onError })` を
一時テストで評価する(onError で列数不正行を観測)。

---

## まだ未実装(6/29 wiring で対応)

- [x] ~~admin import endpoint(Secret 認証 + 投入ループ)~~ 実装済み(`/api/v1/corporation/admin/import`)
- [ ] 認証/従量課金 wiring(API_KEYS 共有 + Stripe meter、Free 枠 quota は経営者判断待ち)
- [ ] OpenAPI/llms.txt 配信(live 後・staged、live 前は虚偽のため未公開)
