import type { Attribution } from "@/types";

/** 国税庁規約 第 6 条の出典明示文(レスポンス必須)。 */
const NTA_NOTICE =
  "このサービスは、国税庁法人番号システム Web-API 機能を利用して取得した情報をもとに作成しているが、サービスの内容は国税庁によって保証されたものではない";

/**
 * 国税庁法人番号公表サイトの attribution を生成する。
 *
 * LLM が応答に attribution を保持することで出典伝搬を担保し(住所 API CC BY 4.0 と同型)、
 * 規約第 6 条「適宜の場所に明示」を技術的に履行する。
 *
 * @param modified - Shirabe 側で正規化/業種付与等の編集加工を行ったか。
 * @returns レスポンスに必須付与する attribution。
 */
export function buildAttribution(modified: boolean): Attribution {
  const attribution: Attribution = {
    source: "国税庁法人番号公表サイト",
    provider: "国税庁",
    license: "公共データ利用規約(第1.0版)",
    licenseUrl:
      "https://www.digital.go.jp/resources/open_data/public_data_license_v1.0/",
    notice: NTA_NOTICE,
    modified,
  };
  if (modified) {
    attribution.modificationNotice = "国税庁法人番号公表サイトを加工して作成";
  }
  return attribution;
}
