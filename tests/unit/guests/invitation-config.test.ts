import { stat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { type } from "arktype";
import { afterEach, expect, test } from "vitest";

import {
  headplaneConfig,
  type PartialHeadplaneConfigWithPaths,
} from "~/server/config/config-schema";
import { loadConfigEnv, loadConfigKeyPaths } from "~/server/config/load";
import { createGuestMailer, invitationMail } from "~/server/guest-mail";

import { tempDir, tempFile } from "../../support/temp";

function parsed(extra: Record<string, unknown>) {
  const config = headplaneConfig({
    server: { cookie_secret: "s".repeat(32) },
    headscale: { url: "https://unused.test" },
    ...extra,
  });
  if (config instanceof type.errors) throw new Error(config.summary);
  return config;
}
afterEach(() => {
  delete process.env.HEADPLANE_GUEST_INVITATIONS__SMTP__PASSWORD;
  delete process.env.HEADPLANE_GUEST_INVITATIONS__SMTP__USERNAME;
});

test("SMTP credentials use protected file loading and numeric or boolean-like environment credentials remain strings", async () => {
  const passwordPath = await tempFile("smtp-password", "smtp-test-password\n");
  const raw = {
    guest_invitations: { smtp: { password_path: passwordPath } },
  } as PartialHeadplaneConfigWithPaths;
  await loadConfigKeyPaths(raw);
  expect(raw.guest_invitations?.smtp?.password).toBe("smtp-test-password");
  process.env.HEADPLANE_GUEST_INVITATIONS__SMTP__PASSWORD = "12345678";
  process.env.HEADPLANE_GUEST_INVITATIONS__SMTP__USERNAME = "true";
  const env = await loadConfigEnv();
  expect(env?.guest_invitations?.smtp).toMatchObject({ password: "12345678", username: "true" });
});

test("disabled delivery sends nothing without requiring SMTP or a public URL", async () => {
  const mailer = await createGuestMailer(parsed({}));
  expect(mailer.enabled).toBe(false);
  expect(
    await mailer.send(
      invitationMail("guest@example.test", "Guest", "Headplane", new Date(), "https://unused.test"),
    ),
  ).toEqual({ ok: false, error: "disabled" });
});

test("file delivery writes private local MIME messages and never contacts an external recipient", async () => {
  const dir = await tempDir();
  const mailer = await createGuestMailer(
    parsed({
      server: {
        cookie_secret: "s".repeat(32),
        data_path: dir,
        base_url: "http://127.0.0.1:3001",
        cookie_secure: false,
      },
      guest_invitations: { enabled: true, transport: "file" },
    }),
  );
  expect(
    await mailer.send(
      invitationMail(
        "guest@example.test",
        "Guest",
        "Headplane",
        new Date(),
        "http://127.0.0.1:3001/admin/invite#token=test",
      ),
    ),
  ).toEqual({ ok: true, value: undefined });
  const path = join(dir, "guest-mail", (await readdir(join(dir, "guest-mail")))[0]);
  expect((await stat(path)).mode & 0o777).toBe(0o600);
  expect((await stat(join(dir, "guest-mail"))).mode & 0o777).toBe(0o700);
  expect(await readFile(path, "utf8")).toContain("multipart/alternative");
});

test("enabled delivery rejects insecure public origins, credentials in URLs, header injection and incomplete SMTP credentials", async () => {
  for (const base_url of [
    "http://public.example.test",
    "https://user:password@example.test",
    "https://example.test/path",
    "https://example.test?tracking=1",
    "javascript:alert(1)",
  ]) {
    await expect(
      createGuestMailer(
        parsed({
          server: { cookie_secret: "s".repeat(32), base_url },
          guest_invitations: { enabled: true, transport: "file" },
        }),
      ),
    ).rejects.toThrow("server.base_url");
  }
  await expect(
    createGuestMailer(
      parsed({
        server: {
          cookie_secret: "s".repeat(32),
          base_url: "https://example.test",
          cookie_secure: false,
        },
        guest_invitations: { enabled: true, smtp: { host: "localhost" } },
      }),
    ),
  ).rejects.toThrow("cookie_secure");
  await expect(
    createGuestMailer(
      parsed({
        server: { cookie_secret: "s".repeat(32), base_url: "https://example.test" },
        guest_invitations: {
          enabled: true,
          from_name: "sender\r\nInjected: yes",
          smtp: { host: "localhost" },
        },
      }),
    ),
  ).rejects.toThrow("single-line");
  await expect(
    createGuestMailer(
      parsed({
        server: { cookie_secret: "s".repeat(32), base_url: "https://example.test" },
        guest_invitations: { enabled: true, smtp: { host: "localhost", username: "test" } },
      }),
    ),
  ).rejects.toThrow("both credentials");
});
