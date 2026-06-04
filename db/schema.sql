-- Shirabe Corporation Number API — D1 schema(PoC)
--
-- 列レイアウトは WS-1 実測に準拠(国税庁 全件 CSV、NTA Web-API Ver.4 系 30 列):
--   knowledge/20260530-corporation-api-ws1-fulldata-measurement.md
-- 全国 ~540 万社 / 展開後 ~1.17GB(UTF-8)→ D1 10GB/DB 上限に余裕。
-- 取込は都道府県別 47 ファイル順次 + 日次差分 upsert(WS-4)。
--
-- ★ 本ファイルは設計(DDL)。D1 provisioning(wrangler d1 create)は WS-2 で実施。

CREATE TABLE IF NOT EXISTS corporations (
  law_id           TEXT PRIMARY KEY,            -- 法人番号(13 桁)
  name             TEXT NOT NULL,               -- 商号又は名称(漢字)
  name_kana        TEXT,                        -- フリガナ(充足率 ~57%、残りは text API で補完)
  name_english     TEXT,                        -- 英語名(充足率 ~0.6%)
  corp_type        TEXT,                        -- 法人種別コード
  prefecture       TEXT,                        -- 国内所在地(都道府県)
  city             TEXT,                        -- 国内所在地(市区町村)
  street           TEXT,                        -- 国内所在地(丁目番地等)
  prefecture_code  TEXT,                        -- 都道府県コード(住所 API と join 可)
  city_code        TEXT,                        -- 市区町村コード(住所 API と join 可)
  postal_code      TEXT,                        -- 郵便番号
  assigned_at      TEXT,                        -- 法人番号指定年月日
  closed_at        TEXT,                        -- 登記記録の閉鎖等年月日
  closed_reason    TEXT,                        -- 登記記録の閉鎖等の事由
  successor_law_id TEXT,                        -- 承継先法人番号(合併追跡)
  latest           INTEGER NOT NULL DEFAULT 1,  -- 最新履歴 = 1
  search_excluded  INTEGER NOT NULL DEFAULT 0,  -- 検索対象除外 = 1
  updated_at       TEXT                         -- 取込時刻(運用メタ)
);

-- 商号検索(前方一致は LIKE 'x%' で本 index 利用可)。
-- 部分一致を多用するなら FTS5 仮想表を別途検討(scoping §3 Option C)。
CREATE INDEX IF NOT EXISTS idx_corporations_name ON corporations (name);

-- 都道府県 / 市区町村による絞り込み。
CREATE INDEX IF NOT EXISTS idx_corporations_pref_code ON corporations (prefecture_code);
CREATE INDEX IF NOT EXISTS idx_corporations_city_code ON corporations (city_code);

-- 基本 WHERE(最新履歴 = 1 AND 検索対象除外 = 0)を効かせる複合 index。
CREATE INDEX IF NOT EXISTS idx_corporations_active ON corporations (latest, search_excluded);
