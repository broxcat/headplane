import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { startGuestArchive } from "../../harness/guest-archive";
import { createTailnet } from "../../harness/tailnet";

test.runIf(process.env.HP_GUEST_ARCHIVE)(
  "the downloaded-layout archive runs without node_modules, migrates, authenticates and stores a Guest in isolation",
  async () => {
    const archive = process.env.HP_GUEST_ARCHIVE!;
    const sums = await readFile(join(dirname(archive), "SHA256SUMS"), "utf8");
    const digest = createHash("sha256")
      .update(await readFile(archive))
      .digest("hex");
    expect(sums).toContain(digest);
    await using tailnet = await createTailnet({ policy: { acls: [] } });
    const before = await tailnet.api.policy.get();
    await using app = await startGuestArchive(tailnet, archive);
    const browser = await chromium.launch({ headless: true });
    try {
      const page = await browser.newPage();
      await page.goto(app.base + "/guests");
      await page.getByLabel("API key", { exact: true }).fill(tailnet.server.apiKey);
      await page.getByRole("button", { name: "Sign in with API key", exact: true }).click();
      await page.getByRole("link", { name: "Guests", exact: true }).click();
      expect((await page.context().cookies()).find((c) => c.name === "_hp_auth")?.httpOnly).toBe(
        true,
      );
      await page.getByRole("button", { name: "Add Guest", exact: true }).click();
      await page.getByLabel("Email", { exact: true }).fill("archive-validation@example.test");
      await page.getByLabel("Display name", { exact: true }).fill("Archive validation");
      await page.getByRole("button", { name: "Create draft", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Add Guest", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "Archive validation", exact: true }).click();
      await page.getByText("12 hours", { exact: true }).waitFor();
      await page.getByText("VPN access not provisioned", { exact: true }).waitFor();
      await page.reload();
      await page.getByText("12 hours", { exact: true }).waitFor();
      expect((await page.request.get(app.base + "/hp_ssh.wasm")).status()).toBe(200);
      expect((await page.request.get(app.base + "/server/index.js.map")).status()).toBe(404);
      const health = await app.container.exec(["/app/hp_healthcheck"]);
      expect(health.exitCode).toBe(0);
      const check = await app.container.exec([
        "node",
        "--input-type=module",
        "-e",
        `import{existsSync}from'node:fs';import{DatabaseSync}from'node:sqlite';const db=new DatabaseSync('/data/hp_persist.db',{readOnly:true});console.log(JSON.stringify({nodeModules:existsSync('/app/node_modules'),migrations:db.prepare('select count(*) as n from __drizzle_migrations').get().n,plan:db.prepare('select requested_duration_seconds,activated_at,expires_at from guests').get()}));db.close();`,
      ]);
      expect(JSON.parse(check.stdout)).toEqual({
        nodeModules: false,
        migrations: 13,
        plan: { requested_duration_seconds: 43200, activated_at: null, expires_at: null },
      });
      expect(await tailnet.api.policy.get()).toEqual(before);
    } finally {
      await browser.close();
    }
  },
);
