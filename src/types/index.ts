/**
 * Shirabe Corporation Number API — 型定義集約。
 * 規約: 型定義は types に集約(project CLAUDE.md §5)。
 */

/**
 * Cloudflare Workers の環境バインディング。
 * PoC 段階では vars のみ。D1 binding(CORP_DB)は WS-2 provisioning 後に wrangler.toml で有効化する。
 * 型は optional とし、未 provisioning でも build/型整合が成立する(handler 側で存在を判定)。
 */
export interface Env {
  /** API バージョン(wrangler.toml [vars])。 */
  API_VERSION: string;
  /**
   * 法人データ D1(`corporations` 表)。WS-2(`wrangler d1 create`)後に binding 有効化。
   * 未 provisioning の間は undefined となり、依存 endpoint は 503 を返す。
   */
  CORP_DB?: D1Database;
  /**
   * admin データ投入 endpoint の Secret トークン。`wrangler secret put` で注入。
   * 未設定の間は投入 endpoint が無効(503)。値はコードに直書きしない(親 §0)。
   */
  ADMIN_IMPORT_TOKEN?: string;
  /**
   * 月間利用量カウント KV(`usage-monthly:{customerId}:{YYYY-MM}`)。
   * ★ corp 専用 namespace(cross-API quota 衝突回避のため共有しない)。
   * WS-2 で provisioning + binding 有効化。未設定の間は usage-check が pass-through。
   */
  USAGE_LOGS?: KVNamespace;
  /**
   * 認証用 KV(per-request key の `{sha256hex}` + Hub license の `license:{key}`)。
   * ★ 暦/住所/text と同一の集約 namespace を**共有**(2026-06-16 経営者サインオフ ①)。
   * 発行・書込は calendar の webhook に集約し、corp は読み取り専用。
   * 未 binding の間は auth が匿名 Free に pass-through(inert・挙動不変)。
   */
  API_KEYS?: KVNamespace;
  /**
   * enrich 内部 subrequest(案 X)識別トークン。calendar の enrich endpoint と共有する
   * 共有シークレット。`X-Shirabe-Internal` がこの値と一致する subrequest は課金対象外
   * (非計上)。未設定時は honor しない(fail-closed)。enrich live(7/1)時に同一値投入。
   */
  INTERNAL_ENRICH_TOKEN?: string;
  /**
   * Stripe Secret Key(`sk_live_*` / `sk_test_*`)。checkout / webhook が `fetch` で
   * Stripe REST を直叩きする際に使用(`stripe` npm 不使用、親 §4)。
   * `wrangler secret put` で注入。値はコードに直書きしない(親 §0)。
   * 未設定の間は checkout が 500(購入不可)、webhook は署名検証以前に 500。= inert(本番挙動不変)。
   */
  STRIPE_SECRET_KEY?: string;
  /**
   * Stripe Webhook 署名検証用 Secret(`whsec_*`)。corp 専用 webhook endpoint の署名検証に使用。
   * `wrangler secret put` で注入。未設定の間は webhook が 500 を返す(= inert)。
   */
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * corp 従量課金 metered Price ID(住所クラス、Starter ¥0.5/回)。
   * Stripe ダッシュボードで corp 専用メーター `corporation_api_requests` 紐付けの metered Price を
   * 作成後に注入(経営者タスク)。未設定の間は当該プランの checkout が 500。
   */
  STRIPE_PRICE_STARTER?: string;
  /** corp 従量課金 metered Price ID(Pro ¥0.3/回)。 */
  STRIPE_PRICE_PRO?: string;
  /** corp 従量課金 metered Price ID(Enterprise ¥0.1/回)。 */
  STRIPE_PRICE_ENTERPRISE?: string;
}

/**
 * ミドルウェアが Context に設定する変数の型(暦/住所と同形)。
 * auth(API_KEYS 共有)wiring は 6/29 で実施するため、現状は optional。
 */
export interface AppVariables {
  /** corporation API に対して解決されたプラン(auth 未 wiring 時は undefined)。 */
  plan?: "free" | "starter" | "pro" | "enterprise";
  /** 顧客識別子(匿名時は anon_<ip_hash>)。auth 未 wiring 時は undefined。 */
  customerId?: string;
}

/** Hono アプリケーションの型パラメータ。 */
export interface AppEnv {
  Bindings: Env;
  Variables: AppVariables;
}

/**
 * 統一エラーレスポンス(project CLAUDE.md §5)。
 * すべての異常系はこの形でクライアントへ返す。
 */
export interface ApiError {
  error: {
    /** 機械可読なエラーコード(UPPER_SNAKE_CASE)。 */
    code: string;
    /** 人間/AI 可読の説明。 */
    message: string;
    /** 追加情報(任意)。 */
    details?: unknown;
  };
}

/**
 * 国税庁 全件 CSV(NTA Web-API Ver.4 系)の 30 列レイアウト(0 始まり、ヘッダ無し)。
 * 出典: WS-1 実測(knowledge/20260530-corporation-api-ws1-fulldata-measurement.md §3)。
 */
export const CsvColumn = {
  SEQUENCE: 0,
  LAW_ID: 1,
  PROCESS_KIND: 2,
  CORRECT_KIND: 3,
  UPDATED_AT: 4,
  CHANGED_AT: 5,
  NAME: 6,
  NAME_IMAGE_ID: 7,
  CORP_TYPE: 8,
  PREFECTURE: 9,
  CITY: 10,
  STREET: 11,
  ADDRESS_IMAGE_ID: 12,
  PREFECTURE_CODE: 13,
  CITY_CODE: 14,
  POSTAL_CODE: 15,
  FOREIGN_ADDRESS: 16,
  FOREIGN_ADDRESS_IMAGE_ID: 17,
  CLOSED_AT: 18,
  CLOSED_REASON: 19,
  SUCCESSOR_LAW_ID: 20,
  CHANGE_DETAIL: 21,
  ASSIGNED_AT: 22,
  LATEST: 23,
  NAME_EN: 24,
  PREFECTURE_EN: 25,
  ADDRESS_EN: 26,
  FOREIGN_ADDRESS_EN: 27,
  KANA: 28,
  SEARCH_EXCLUDED: 29,
} as const;

/** 国税庁 全件 CSV の固定列数。 */
export const CSV_COLUMN_COUNT = 30;

/** D1 に格納する正規化済み法人レコード(空文字列は null 化)。 */
export interface CorporationRecord {
  lawId: string;
  name: string;
  nameKana: string | null;
  nameEnglish: string | null;
  corpType: string | null;
  prefecture: string | null;
  city: string | null;
  street: string | null;
  prefectureCode: string | null;
  cityCode: string | null;
  postalCode: string | null;
  assignedAt: string | null;
  closedAt: string | null;
  closedReason: string | null;
  successorLawId: string | null;
  /** 最新履歴 = 1。 */
  latest: boolean;
  /** 検索対象除外 = 1。 */
  searchExcluded: boolean;
}

/** 国税庁出典 attribution(規約第 6 条 + LLM 出典伝搬)。 */
export interface Attribution {
  source: string;
  provider: string;
  license: string;
  licenseUrl: string;
  notice: string;
  modified: boolean;
  modificationNotice?: string;
}

/** lookup エンドポイントの成功レスポンス(単一法人 + 出典)。 */
export interface LookupResponse {
  corporation: CorporationRecord;
  attribution: Attribution;
}

/** search エンドポイントの成功レスポンス(前方一致結果 + 出典 + ページング)。 */
export interface SearchResponse {
  results: CorporationRecord[];
  /** 本ページの件数(results.length)。 */
  count: number;
  limit: number;
  offset: number;
  attribution: Attribution;
}

/** batch lookup の 1 件分の結果。 */
export interface BatchLookupItem {
  lawId: string;
  /** 形式 + checksum が妥当か(不正なら検索もしない)。 */
  valid: boolean;
  /** registry に存在したか。 */
  found: boolean;
  /** 見つかった法人(なければ null)。 */
  corporation: CorporationRecord | null;
}

/** batch エンドポイントの成功レスポンス。 */
export interface BatchResponse {
  results: BatchLookupItem[];
  attribution: Attribution;
}

/** admin データ投入エンドポイントの成功レスポンス。 */
export interface AdminImportResponse {
  /** upsert したレコード数(最新履歴のみ)。 */
  imported: number;
  /** 列数不正等でスキップした行数。 */
  skipped: number;
  /** 実行した db.batch() の回数。 */
  batches: number;
  /** 取込時刻(updated_at に格納した ISO 文字列)。 */
  importedAt: string;
}

/** validate エンドポイントの結果。 */
export interface ValidateResult {
  lawId: string;
  /** 13 桁数字の形式 OK か。 */
  formatValid: boolean;
  /** チェックディジット(mod 9)一致か。 */
  checksumValid: boolean;
  /** 形式 + チェックディジット双方 OK か。 */
  valid: boolean;
  /** registry 実在確認。D1 データ層未接続のため現状 null。 */
  existsInRegistry: boolean | null;
  /** 補足。 */
  note?: string;
}
