/**
 * self-serve キー再発行の HTML ページ群(法人番号 API)
 *
 *  - renderReissueFormPage      : メール入力フォーム
 *  - renderReissueRequestedPage : 受付後の汎用「送信しました」(anti-enumeration)
 *  - renderReissueConfirmPage   : 再発行を確定するボタン(prefetch でトークンを消費しない)
 *  - renderReissueResultPage    : 新キー表示 / エラー
 *
 * checkout-success.ts と同じ自己完結 HTML スタイル(layout 非依存)。
 */
import { escapeHtml } from "@/pages/checkout-success";

/** 受付 POST 先 / フォーム GET 先(法人番号 API のパス名前空間配下)。 */
const REISSUE_PATH = "/api/v1/corporation/keys/reissue";
/** 確定 POST 先。 */
const CONFIRM_PATH = "/api/v1/corporation/keys/reissue/confirm";

/** 自己完結 HTML ドキュメントでラップする(checkout-success.ts と同スタイル)。 */
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
  input[type=email] { width: 100%; max-width: 420px; padding: .5rem; border: 1px solid #cbd5e1; border-radius: 6px; }
  button { padding: .6rem 1.4rem; border: none; border-radius: 6px; font-weight: 600; cursor: pointer; color: #fff; }
  .btn-primary { background: #2563eb; } .btn-danger { background: #dc2626; }
</style>
</head>
<body>
${body}
</body>
</html>`;
}

/** メール入力フォーム。 */
export function renderReissueFormPage(errorMessage?: string): string {
  const errorBlock = errorMessage
    ? `<p style="color:#b91c1c;font-weight:600">${escapeHtml(errorMessage)}</p>`
    : "";
  const body = `
<h1>APIキーの再発行</h1>
<p>キーを紛失した場合の self-serve 再発行です。ご契約時のメールアドレスを入力してください。有効な契約がある場合、再発行用の確認リンクをそのメールアドレス宛にお送りします。</p>
<div class="card">
  ${errorBlock}
  <form method="post" action="${REISSUE_PATH}">
    <p><label for="email">メールアドレス</label><br>
    <input type="email" id="email" name="email" required placeholder="you@example.com"></p>
    <p><button type="submit" class="btn-primary">確認メールを送る</button></p>
  </form>
  <p class="muted">確認リンクをクリックして再発行を確定すると、新しい API キーが一度だけ表示され、古いキーは無効になります。</p>
</div>
`;
  return htmlDoc("APIキーの再発行 — Shirabe 法人番号 API", body);
}

/** 受付後の汎用ページ(契約有無で文面を変えない)。 */
export function renderReissueRequestedPage(): string {
  const body = `
<h1>確認メールをお送りしました</h1>
<div class="card">
  <p>入力されたメールアドレスに有効な契約がある場合、再発行用の確認リンクを記載したメールをお送りしました。メール内のリンク(有効期限 30 分)を開いて再発行を確定してください。</p>
  <p class="muted">数分待ってもメールが届かない場合は、迷惑メールフォルダをご確認のうえ、メールアドレスが正しいか再度お試しください。</p>
  <p><a href="https://shirabe.dev/">トップページに戻る</a></p>
</div>
`;
  return htmlDoc("確認メールを送信しました — Shirabe 法人番号 API", body);
}

/** 再発行を確定するボタンページ(GET、token を hidden で POST に引き継ぐ)。 */
export function renderReissueConfirmPage(token: string): string {
  const safeToken = escapeHtml(token);
  const body = `
<h1>再発行の確定</h1>
<p>下のボタンで新しい API キーを発行します。</p>
<div class="card warn">
  <p style="color:#92400e"><strong>確定すると古い API キーは即座に無効になります。</strong> 古いキーを使っている連携がある場合は、表示される新しいキーに差し替えてください。</p>
</div>
<div class="card">
  <form method="post" action="${CONFIRM_PATH}">
    <input type="hidden" name="token" value="${safeToken}">
    <button type="submit" class="btn-danger">再発行を確定する</button>
  </form>
</div>
`;
  return htmlDoc("再発行の確定 — Shirabe 法人番号 API", body);
}

/** 再発行結果ページ(新キー表示 / エラー)。 */
export function renderReissueResultPage(newKey: string | null): string {
  if (!newKey) {
    const body = `
<h1>再発行できませんでした</h1>
<div class="card">
  <p>確認リンクが無効、または有効期限(30 分)が切れています。リンクは一度のみ有効です。お手数ですが、もう一度最初からお試しください。</p>
  <p><a href="${REISSUE_PATH}">再発行をやり直す</a></p>
</div>
`;
    return htmlDoc("再発行できませんでした — Shirabe 法人番号 API", body);
  }

  const safeKey = escapeHtml(newKey);
  const body = `
<h1>再発行が完了しました</h1>
<div class="card warn">
  <h2 style="margin-top:0;color:#92400e">&#x26A0; 重要: APIキーは一度しか表示されません</h2>
  <p>下の新しい API キーは、このページを離れると<strong>二度と表示されません</strong>。必ず安全な場所(パスワードマネージャ等)に保管してください。古いキーは無効になりました。</p>
  <p class="muted">新しいキーは反映まで最大 1 分ほどかかる場合があります(直後は 401 になることがあります)。</p>
</div>
<h2>新しいAPIキー</h2>
<div class="card"><pre><code>${safeKey}</code></pre></div>
<h2>使い方</h2>
<pre><code>curl -X POST "https://shirabe.dev/api/v1/corporation/lookup" \\
  -H "X-API-Key: ${safeKey}" \\
  -H "Content-Type: application/json" \\
  -d '{"law_id":"1234567890123"}'</code></pre>
<p><a href="https://shirabe.dev/">トップページに戻る</a></p>
`;
  return htmlDoc("再発行が完了しました — Shirabe 法人番号 API", body);
}
