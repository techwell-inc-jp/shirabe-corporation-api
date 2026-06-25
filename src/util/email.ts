/**
 * Email Sending(Cloudflare Email Service)経由の送信ユーティリティ
 *
 * キー紛失時の self-serve 再発行フローで、検証リンクを登録メール宛に送る。
 * Email Routing(受信転送)とは別機能の send_email binding(`env.EMAIL`)を使う。
 * binding 未設定時は送信せず false を返し、フロー全体を壊さない(anti-enumeration の
 * 汎用レスポンスは維持される)。住所 API の src/util/email.ts と同型。
 */
import type { Env } from "@/types";

/** 送信元アドレス(オンボード済の shirabe.dev、返信不要なので noreply)。 */
export const REISSUE_FROM_EMAIL = "noreply@shirabe.dev";
/** 送信者表示名。 */
export const REISSUE_FROM_NAME = "Shirabe API";

/**
 * 再発行検証メールの件名・本文(text / html)を組み立てる純粋関数。
 *
 * @param confirmUrl ワンタイム検証リンク(クリックで再発行を確定するページ)
 */
export function buildReissueEmail(confirmUrl: string): {
  subject: string;
  text: string;
  html: string;
} {
  const subject = "Shirabe API キーの再発行確認";
  const text = [
    "Shirabe API キーの再発行リクエストを受け付けました。",
    "",
    "以下のリンクを開き、再発行を確定してください(リンクの有効期限は30分です)。",
    confirmUrl,
    "",
    "確定すると新しい API キーが画面に一度だけ表示され、古いキーは無効になります。",
    "",
    "このリクエストに心当たりがない場合は、このメールを破棄してください。キーは変更されません。",
    "",
    "— Shirabe API (https://shirabe.dev)",
  ].join("\n");
  const html = `<!DOCTYPE html>
<html lang="ja"><body style="font-family:sans-serif;line-height:1.7;color:#1f2937">
  <h2>Shirabe API キーの再発行確認</h2>
  <p>Shirabe API キーの再発行リクエストを受け付けました。</p>
  <p>下のボタンを押して再発行を確定してください(有効期限は<strong>30分</strong>です)。</p>
  <p><a href="${confirmUrl}" style="display:inline-block;background:#2563eb;color:#fff;padding:12px 20px;border-radius:6px;text-decoration:none">再発行を確定する</a></p>
  <p style="font-size:.875rem;color:#6b7280">ボタンが押せない場合はこの URL を開いてください:<br>${confirmUrl}</p>
  <p>確定すると新しい API キーが画面に一度だけ表示され、古いキーは無効になります。</p>
  <p style="font-size:.875rem;color:#6b7280">このリクエストに心当たりがない場合は、このメールを破棄してください。キーは変更されません。</p>
  <hr style="border:none;border-top:1px solid #e5e7eb">
  <p style="font-size:.75rem;color:#9ca3af">Shirabe API — <a href="https://shirabe.dev">https://shirabe.dev</a></p>
</body></html>`;
  return { subject, text, html };
}

/**
 * 再発行検証メールを送信する。binding 未設定 / 失敗時は false(例外を投げない)。
 *
 * @param env Workers バインディング(EMAIL を参照)
 * @param to 宛先(登録メール)
 * @param confirmUrl ワンタイム検証リンク
 */
export async function sendReissueEmail(
  env: Env,
  to: string,
  confirmUrl: string
): Promise<boolean> {
  if (!env.EMAIL || typeof env.EMAIL.send !== "function") return false;
  const { subject, text, html } = buildReissueEmail(confirmUrl);
  try {
    await env.EMAIL.send({
      to,
      from: { email: REISSUE_FROM_EMAIL, name: REISSUE_FROM_NAME },
      subject,
      text,
      html,
    });
    return true;
  } catch (err) {
    console.error("[reissue] email send failed", err);
    return false;
  }
}
