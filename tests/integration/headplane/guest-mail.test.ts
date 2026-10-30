import { type } from "arktype";
import { expect, test } from "vitest";

import { headplaneConfig } from "~/server/config/config-schema";
import { createGuestMailer, invitationMail } from "~/server/guest-mail";

import { startTestSmtp } from "../../harness/smtp";
import { tempDir } from "../../support/temp";

async function config(
  port: number,
  ca: string | undefined,
  security: "tls" | "starttls",
  password = "test-password",
) {
  const result = headplaneConfig({
    server: {
      cookie_secret: "s".repeat(32),
      base_url: "https://headplane.test",
      data_path: await tempDir(),
    },
    headscale: { url: "https://unused.test" },
    guest_invitations: {
      enabled: true,
      transport: "smtp",
      timeout_ms: 1000,
      retries: 1,
      smtp: {
        host: "127.0.0.1",
        port,
        security,
        username: "test-user",
        password,
        ...(ca ? { ca_path: ca } : {}),
      },
    },
  });
  if (result instanceof type.errors) throw new Error(result.summary);
  return result;
}
const message = () =>
  invitationMail(
    "guest@example.test",
    "Guest <script>",
    "Headplane",
    new Date("2035-01-01"),
    "https://headplane.test/admin/invite#token=test",
  );

test.for(["tls", "starttls"] as const)(
  "SMTP uses authenticated %s and delivers both HTML and text without tracking",
  async (security) => {
    await using smtp = await startTestSmtp({ security });
    const mailer = await createGuestMailer(await config(smtp.port, smtp.caPath, security));
    expect(await mailer.send(message())).toEqual({ ok: true, value: undefined });
    expect(smtp.messages).toHaveLength(1);
    expect(smtp.messages[0]).toContain("multipart/alternative");
    expect(smtp.messages[0]).toContain("text/plain");
    expect(smtp.messages[0]).toContain("text/html");
    expect(message().html).toContain("&lt;script&gt;");
    expect(message().html).not.toContain("<script>");
    expect(message().html).not.toMatch(/<img|tracking/i);
  },
);

test("SMTP refuses an untrusted certificate, invalid credentials and missing STARTTLS", async () => {
  await using smtp = await startTestSmtp();
  expect(
    await (await createGuestMailer(await config(smtp.port, undefined, "starttls"))).send(message()),
  ).toEqual({ ok: false, error: "delivery_failed" });
  expect(
    await (
      await createGuestMailer(await config(smtp.port, smtp.caPath, "starttls", "wrong"))
    ).send(message()),
  ).toEqual({ ok: false, error: "delivery_failed" });
  expect(smtp.messages).toEqual([]);
  await using insecure = await startTestSmtp({ security: "starttls", hideStartTls: true });
  expect(
    await (
      await createGuestMailer(await config(insecure.port, insecure.caPath, "starttls"))
    ).send(message()),
  ).toEqual({ ok: false, error: "delivery_failed" });
  expect(insecure.messages).toEqual([]);
});

test.for(["temporary", "permanent"] as const)(
  "SMTP retries %s refusals only within the configured bound",
  async (reject) => {
    await using smtp = await startTestSmtp({ security: "starttls", reject });
    const mailer = await createGuestMailer(await config(smtp.port, smtp.caPath, "starttls"));
    expect(await mailer.send(message())).toEqual({ ok: false, error: "delivery_failed" });
    expect(smtp.attempts()).toBe(reject === "temporary" ? 2 : 1);
  },
);

test.for(["tls", "starttls"] as const)(
  "connection check negotiates %s and authenticates without sending",
  async (security) => {
    await using smtp = await startTestSmtp({ security });
    const mailer = await createGuestMailer(await config(smtp.port, smtp.caPath, security));
    expect(await mailer.check()).toEqual({ ok: true, value: "smtp" });
    expect(smtp.messages).toEqual([]);
    expect(smtp.attempts()).toBe(0);
    expect(await mailer.check()).toEqual({ ok: false, error: "rate_limited" });
    const invalid = await createGuestMailer(
      await config(smtp.port, smtp.caPath, security, "wrong"),
    );
    expect(await invalid.check()).toEqual({ ok: false, error: "delivery_failed" });
    expect(smtp.messages).toEqual([]);
  },
);
