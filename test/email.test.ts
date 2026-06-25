/**
 * Email Sending 送信ユーティリティのテスト(法人番号 API)
 */
import { describe, it, expect, vi } from "vitest";
import { buildReissueEmail, sendReissueEmail, REISSUE_FROM_EMAIL } from "@/util/email";
import type { Env, EmailSendMessage } from "@/types";

describe("buildReissueEmail", () => {
  const url = "https://shirabe.dev/api/v1/corporation/keys/reissue/confirm?token=abc";
  it("件名・text・html を返し、いずれも確認 URL を含む", () => {
    const mail = buildReissueEmail(url);
    expect(mail.subject).toContain("再発行");
    expect(mail.text).toContain(url);
    expect(mail.html).toContain(url);
  });
});

describe("sendReissueEmail", () => {
  function envWith(emailMock?: Env["EMAIL"]): Env {
    return { EMAIL: emailMock } as unknown as Env;
  }

  it("EMAIL binding 未設定なら false", async () => {
    expect(await sendReissueEmail(envWith(undefined), "u@example.com", "https://x")).toBe(false);
  });

  it("送信成功で true、from は noreply@shirabe.dev", async () => {
    let captured: EmailSendMessage | undefined;
    const send = vi.fn(async (m: EmailSendMessage) => {
      captured = m;
      return {};
    });
    const ok = await sendReissueEmail(envWith({ send }), "u@example.com", "https://x/confirm");
    expect(ok).toBe(true);
    expect(captured!.from.email).toBe(REISSUE_FROM_EMAIL);
    expect(captured!.text).toContain("https://x/confirm");
  });

  it("送信が throw しても false", async () => {
    const send = vi.fn(async () => {
      throw new Error("fail");
    });
    expect(await sendReissueEmail(envWith({ send }), "u@example.com", "https://x")).toBe(false);
  });
});
