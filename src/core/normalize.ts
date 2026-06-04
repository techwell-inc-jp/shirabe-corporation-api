/**
 * 法人名の正規化(/normalize)— データ層不要の純ロジック。
 *
 * AI エージェント / 開発者が手元の表記ゆれ社名を、検索や突合に使える正規形へ寄せる。
 * 処理: NFKC 正規化(全角英数 → 半角・半角カナ → 全角・㈱ → (株) 等)→ 法人種別の
 * 略記展開((株) → 株式会社 等)→ 連続空白の単一化 → 法人種別語の検出・分離。
 *
 * registry 実在確認は伴わない(それは lookup/search の役割)。出典加工なし(国税庁データを
 * 参照しないため attribution 不要)。
 */

/** 括弧略記 → 正式名称。NFKC 後の半角括弧表記をキーにする(㈱ → "(株)" → 株式会社)。 */
const ABBREVIATIONS: ReadonlyArray<readonly [RegExp, string]> = [
  [/\(株\)/g, "株式会社"],
  [/\(有\)/g, "有限会社"],
  [/\(合\)/g, "合同会社"],
  [/\(同\)/g, "合同会社"],
  [/\(資\)/g, "合資会社"],
  [/\(名\)/g, "合名会社"],
  [/\(医\)/g, "医療法人"],
  [/\(財\)/g, "財団法人"],
  [/\(社\)/g, "社団法人"],
  [/\(学\)/g, "学校法人"],
  [/\(宗\)/g, "宗教法人"],
  [/\(福\)/g, "社会福祉法人"],
  [/\(特非\)/g, "特定非営利活動法人"],
];

/**
 * 検出対象の法人種別語(長い順 = 部分一致の誤検出を防ぐ)。
 * 例: 「一般社団法人」を「社団法人」より先に判定する。
 */
const CORP_TYPES: readonly string[] = [
  "特定非営利活動法人",
  "一般社団法人",
  "一般財団法人",
  "公益社団法人",
  "公益財団法人",
  "社会福祉法人",
  "国立大学法人",
  "独立行政法人",
  "株式会社",
  "有限会社",
  "合同会社",
  "合資会社",
  "合名会社",
  "医療法人",
  "学校法人",
  "宗教法人",
  "財団法人",
  "社団法人",
];

/** /normalize の結果。 */
export interface NormalizeResult {
  /** 入力(無加工)。 */
  input: string;
  /** 正規化済み社名(NFKC + 略記展開 + 空白整理)。 */
  normalized: string;
  /** 検出した法人種別語(なければ null)。 */
  corpType: string | null;
  /** 法人種別語の位置(前置/後置、なければ null)。 */
  corpTypePosition: "prefix" | "suffix" | null;
  /** 法人種別語を除いた社名本体(検出なしなら normalized と同一)。 */
  baseName: string;
}

/** 略記を正式名称へ展開する。 */
function expandAbbreviations(value: string): string {
  let out = value;
  for (const [pattern, full] of ABBREVIATIONS) {
    out = out.replace(pattern, full);
  }
  return out;
}

/** 連続する空白(全半角は NFKC で半角化済み)を単一スペースにし trim する。 */
function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * 法人名を正規化する(純粋関数)。
 *
 * @param input 生の社名
 * @returns 正規化結果(正規形 + 法人種別の検出・分離)
 */
export function normalizeCorporationName(input: string): NormalizeResult {
  const nfkc = input.normalize("NFKC");
  const expanded = expandAbbreviations(nfkc);
  const normalized = collapseWhitespace(expanded);

  let corpType: string | null = null;
  let corpTypePosition: "prefix" | "suffix" | null = null;
  let baseName = normalized;

  for (const type of CORP_TYPES) {
    if (normalized.startsWith(type) && normalized.length > type.length) {
      corpType = type;
      corpTypePosition = "prefix";
      baseName = normalized.slice(type.length).trim();
      break;
    }
    if (normalized.endsWith(type) && normalized.length > type.length) {
      corpType = type;
      corpTypePosition = "suffix";
      baseName = normalized.slice(0, normalized.length - type.length).trim();
      break;
    }
  }

  return { input, normalized, corpType, corpTypePosition, baseName };
}
