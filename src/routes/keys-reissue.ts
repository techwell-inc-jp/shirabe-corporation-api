/**
 * self-serve キー再発行(法人番号 API)
 *
 * 認証ミドルウェアは METERED_ROUTES(validate/lookup/search/normalize/batch)にのみ
 * 適用されるため、本ルータ配下は自然に認証バイパスされる(キーを失った顧客が使うため)。
 *
 *   GET  /api/v1/corporation/keys/reissue              — メール入力フォーム
 *   POST /api/v1/corporation/keys/reissue { email }    — 受付(JSON/form)→ 検証メール送信
 *   GET  /api/v1/corporation/keys/reissue/confirm?token= — 確定ボタン(GET では回転しない)
 *   POST /api/v1/corporation/keys/reissue/confirm      — トークン消費 + キー回転 + 新キー表示
 *
 * ★ inert: API_KEYS / USAGE_LOGS 未 binding の間は anti-enumeration の汎用応答だけ返し、
 *   トークン発行・キー回転は行わない(本番挙動不変)。
 */
import { Hono } from "hono";
import type { AppEnv } from "@/types";
import {
  generateReissueToken,
  putReissueToken,
  resolveReissueTarget,
  consumeReissueToken,
  rotatePerRequestKey,
} from "@/keys/reissue-store";
import { sendReissueEmail } from "@/util/email";
import {
  renderReissueFormPage,
  renderReissueRequestedPage,
  renderReissueConfirmPage,
  renderReissueResultPage,
} from "@/pages/keys-reissue";

/** メールアドレスの簡易バリデーション(checkout.ts と同一)。 */
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** 確定ページのベース URL。 */
const CONFIRM_BASE_URL = "https://shirabe.dev/api/v1/corporation/keys/reissue/confirm";
/** anti-enumeration の汎用メッセージ(JSON 応答用)。 */
const GENERIC_MESSAGE =
  "If a matching subscription exists, a reissue confirmation link has been sent to the registered email address.";

export const keysReissue = new Hono<AppEnv>();

// メール入力フォーム
keysReissue.get("/reissue", (c) => c.html(renderReissueFormPage()));

// 受付(JSON / form 両対応、anti-enumeration)
keysReissue.post("/reissue", async (c) => {
  const contentType = c.req.header("content-type") || "";
  const isJson = contentType.includes("application/json");

  let email: string | undefined;
  try {
    if (isJson) {
      const body = (await c.req.json()) as { email?: unknown };
      email = typeof body.email === "string" ? body.email : undefined;
    } else {
      const form = await c.req.parseBody();
      email = typeof form.email === "string" ? form.email : undefined;
    }
  } catch {
    // パース失敗は下のバリデーションで処理。
  }

  const trimmed = email?.trim();
  if (!trimmed || !EMAIL_PATTERN.test(trimmed)) {
    if (isJson) {
      return c.json(
        { error: { code: "INVALID_REQUEST", message: "A valid email address is required." } },
        400
      );
    }
    return c.html(renderReissueFormPage("有効なメールアドレスを入力してください。"), 400);
  }

  // KV 未 binding の間はトークン発行をスキップ(汎用応答は維持 = anti-enumeration)。
  const usageLogs = c.env.USAGE_LOGS;
  if (usageLogs) {
    try {
      const apiKeyHash = await resolveReissueTarget(usageLogs, trimmed);
      if (apiKeyHash) {
        const token = generateReissueToken();
        await putReissueToken(usageLogs, token, {
          ref: apiKeyHash,
          email: trimmed,
          createdAt: new Date().toISOString(),
        });
        await sendReissueEmail(c.env, trimmed, `${CONFIRM_BASE_URL}?token=${token}`);
      }
    } catch (err) {
      console.error("[reissue] request handling failed", err);
    }
  }

  if (isJson) return c.json({ message: GENERIC_MESSAGE });
  return c.html(renderReissueRequestedPage());
});

// 確定ボタン(prefetch でトークンを消費しないよう GET では回転しない)
keysReissue.get("/reissue/confirm", (c) => {
  const token = c.req.query("token");
  if (!token) return c.html(renderReissueResultPage(null));
  return c.html(renderReissueConfirmPage(token));
});

// 確定(トークン消費 + キー回転 + 新キー表示)
keysReissue.post("/reissue/confirm", async (c) => {
  const usageLogs = c.env.USAGE_LOGS;
  const apiKeys = c.env.API_KEYS;
  if (!usageLogs || !apiKeys) return c.html(renderReissueResultPage(null));

  const form = await c.req.parseBody();
  const token = typeof form.token === "string" ? form.token : undefined;
  if (!token) return c.html(renderReissueResultPage(null));
  const record = await consumeReissueToken(usageLogs, token);
  if (!record) return c.html(renderReissueResultPage(null));
  const newKey = await rotatePerRequestKey(apiKeys, usageLogs, record.ref, record.email);
  return c.html(renderReissueResultPage(newKey));
});
