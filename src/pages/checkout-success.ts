/**
 * 法人番号 API 決済完了 / キャンセルページ
 *
 * GET /api/v1/corporation/checkout/success?session_id=cs_xxx
 *   Stripe Checkout Session → metadata.apiKeyHash → corp 専用 USAGE_LOGS の
 *   `checkout-pending:{hash}` から API キー平文を取り出し表示する。
 *   暦 API(`shirabe-calendar/src/pages/checkout-success.ts`)を corp 用に移植。
 *   corp は HTML ページ基盤を持たないため、layout 非依存の自己完結 HTML として実装する。
 *
 * GET /api/v1/corporation/checkout/cancel
 *   決済キャンセル時の戻り先。
 *
 * ★ 重要(本ページ新設の経緯): corp checkout は success_url を本パスに向けていたが
 *   GET route が未登録で 404 だった(顧客が決済後に API キーを受け取れない不具合)。
 */

/** HTML 特殊文字をエスケープする。 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Stripe Checkout Session を取得する(fetch で REST API を直接呼ぶ)。
 */
async function retrieveStripeSession(
  sessionId: string,
  stripeSecretKey: string
): Promise<{ metadata?: { apiKeyHash?: string; plan?: string } } | null> {
  try {
    const res = await fetch(
      `https://api.stripe.com/v1/checkout/sessions/${encodeURIComponent(sessionId)}`,
      { headers: { Authorization: `Basic ${btoa(stripeSecretKey + ":")}` } }
    );
    if (!res.ok) return null;
    return (await res.json()) as { metadata?: { apiKeyHash?: string; plan?: string } };
  } catch {
    return null;
  }
}

/** API キー取得結果。 */
export type KeyResult = {
  apiKey: string | null;
  plan: string | null;
  email: string | null;
};

/**
 * session_id から KV の checkout-pending データを引き、API キー平文を取得する。
 *
 * @param sessionId Stripe Checkout Session ID
 * @param stripeSecretKey Stripe Secret Key(未設定なら null 返却)
 * @param usageLogsKV corp 専用 USAGE_LOGS KVNamespace
 */
export async function resolveApiKeyFromSession(
  sessionId: string | undefined,
  stripeSecretKey: string | undefined,
  usageLogsKV: KVNamespace | undefined
): Promise<KeyResult> {
  const empty: KeyResult = { apiKey: null, plan: null, email: null };
  if (!sessionId || !stripeSecretKey || !usageLogsKV) return empty;

  const session = await retrieveStripeSession(sessionId, stripeSecretKey);
  const apiKeyHash = session?.metadata?.apiKeyHash;
  if (!apiKeyHash) return empty;

  const pendingStr = await usageLogsKV.get(`checkout-pending:${apiKeyHash}`);
  if (!pendingStr) return empty;

  try {
    const pending = JSON.parse(pendingStr) as { apiKey: string; plan: string; email: string };
    return { apiKey: pending.apiKey, plan: pending.plan, email: pending.email };
  } catch {
    return empty;
  }
}

/** 自己完結 HTML ドキュメントでラップする(corp は共通 layout を持たない)。 */
function htmlDoc(title: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escapeHtml(title)}</title>
<style>
  body { font-family: system-ui, -apple-system, "Segoe UI", sans-serif; max-width: 720px; margin: 0 auto; padding: 24px; line-height: 1.7; color: #1e293b; }
  h1 { font-size: 1.5rem; } h2 { font-size: 1.125rem; margin-top: 1.5rem; }
  pre { background: #0f172a; color: #e2e8f0; padding: 12px 14px; border-radius: 6px; overflow-x: auto; }
  code { font-family: ui-monospace, "SFMono-Regular", monospace; }
  .card { border: 1px solid #e2e8f0; border-radius: 8px; padding: 16px; margin: 12px 0; }
  .warn { border-color: #fbbf24; background: #fffbeb; }
  .muted { color: #64748b; font-size: .875rem; }
  a { color: #2563eb; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/**
 * 決済完了ページの HTML を生成する。
 * @param sessionId Stripe Checkout Session ID(クエリパラメータ)
 * @param keyResult resolveApiKeyFromSession の戻り値
 */
export function renderCheckoutSuccessPage(
  sessionId: string | undefined,
  keyResult?: KeyResult
): string {
  const safeId = sessionId ? escapeHtml(sessionId) : "";
  const apiKey = keyResult?.apiKey ?? null;
  const plan = keyResult?.plan ?? null;

  const apiKeyBlock = apiKey
    ? `
    <p style="color:#166534;font-weight:600">プラン: ${plan ? escapeHtml(plan) : ""}</p>
    <pre><code>${escapeHtml(apiKey)}</code></pre>`
    : `
    <p class="muted">
      API キーは決済確認後にこの画面に表示されます。
      表示されない場合は、しばらく待ってからページをリロードしてください。
    </p>
    <pre><code>shrb_XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX</code></pre>`;

  const sessionBlock = safeId
    ? `<p class="muted">Stripe Session ID: <code>${safeId}</code></p>`
    : `<p class="muted">Stripe Session ID が見つかりません。決済導線から再度お試しください。</p>`;

  const keyPlaceholder = apiKey ? escapeHtml(apiKey) : "shrb_your_api_key";

  const body = `
<h1>ご契約ありがとうございます</h1>
<p>法人番号 API の決済が完了しました。</p>

<div class="card warn">
  <h2 style="margin-top:0;color:#92400e">&#x26A0; 重要: API キーは一度しか表示されません</h2>
  <p>下に表示される API キーは、このページを離れると<strong>二度と表示されません</strong>。必ず安全な場所(パスワードマネージャ等)に保管してください。紛失した場合は <a href="/api/v1/corporation/keys/reissue">こちらから再発行</a> できます(登録メールの確認が必要)。</p>
</div>

<h2>あなたの API キー</h2>
<div class="card">
  ${apiKeyBlock}
  ${sessionBlock}
</div>

<h2>使い方</h2>
<pre><code>curl -X POST "https://shirabe.dev/api/v1/corporation/validate" \\
  -H "X-API-Key: ${keyPlaceholder}" \\
  -H "Content-Type: application/json" \\
  -d '{"law_id":"1234567890123"}'</code></pre>

<h2>次のステップ</h2>
<ul>
  <li>API キーを安全な場所に保存する</li>
  <li><a href="https://github.com/techwell-inc-jp/shirabe-corporation-api" target="_blank" rel="noopener">GitHub ドキュメント</a>でエンドポイント一覧を確認する</li>
  <li><a href="https://shirabe.dev/">トップページに戻る</a></li>
</ul>
`;

  return htmlDoc("決済完了 — Shirabe 法人番号 API", body);
}

/**
 * 決済キャンセルページの HTML を生成する。
 */
export function renderCheckoutCancelPage(): string {
  const body = `
<h1>決済をキャンセルしました</h1>
<p>請求は発生していません。いつでも再度お申し込みいただけます。</p>
<ul>
  <li><a href="https://shirabe.dev/pricing">料金ページ</a></li>
  <li><a href="https://shirabe.dev/">トップページに戻る</a></li>
</ul>
`;
  return htmlDoc("決済キャンセル — Shirabe 法人番号 API", body);
}
