import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { chromium, type Browser } from "playwright";
import { expect, test } from "vitest";

import { startHeadplane, writeHeadplaneConfig } from "../../harness/headplane";
import { freePort } from "../../harness/headscale";
import { createTailnet } from "../../harness/tailnet";
import { waitFor } from "../../harness/wait";
import { guestMessages, mailToken, mailCode } from "../../support/guest-mail";

test.runIf(process.env.HP_GUEST_BROWSER === "1")(
  "an email invitation verifies the mailbox before acceptance with no URL token disclosure or third-party requests",
  async () => {
    await using tailnet = await createTailnet({ policy: { acls: [] } });
    const before = await tailnet.api.policy.get();
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const base = `${origin}/guest-console`;
    const config = await writeHeadplaneConfig(tailnet, {
      port,
      server: { base_path: "/guest-console", base_url: origin },
      integration: { docker: { enabled: false } },
      guestInvitations: { enabled: true, transport: "file" },
    });
    const server = startHeadplane(config, port, { isProduction: true });
    const stopped = once(server, "exit");
    let browser: Browser | undefined;
    try {
      await waitFor("isolated invitation server", async () =>
        expect((await fetch(`${base}/healthz`)).ok).toBe(true),
      );
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      await page.goto(`${base}/login`);
      await page.getByLabel("API key", { exact: true }).fill(tailnet.server.apiKey);
      await page.getByRole("button", { name: "Sign in with API key" }).click();
      await page.getByRole("link", { name: "Guests", exact: true }).click();
      await page.getByRole("button", { name: "Add Guest", exact: true }).click();
      await page.getByLabel("Email", { exact: true }).fill("recipient@example.test");
      await page.getByLabel("Display name", { exact: true }).fill("Jordan Lee");
      await page.getByRole("button", { name: "Create draft", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Add Guest", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "Jordan Lee", exact: true }).click();
      await page.getByRole("button", { name: "Send Invitation", exact: true }).click();
      await page.getByLabel("Invitation validity (hours)").fill("24");
      await page.getByRole("button", { name: "Send invitation", exact: true }).click();
      await page
        .getByRole("dialog", { name: /^(Send|Resend) invitation\?$/ })
        .waitFor({ state: "hidden" });
      await page.getByText("Pending", { exact: true }).waitFor();
      const screenshots = process.env.HP_GUEST_SCREENSHOTS;
      if (screenshots) {
        await mkdir(screenshots, { recursive: true });
        for (const colorScheme of ["light", "dark"] as const) {
          await page.emulateMedia({ colorScheme });
          await page.screenshot({
            path: join(screenshots, `invitation-admin-${colorScheme}.png`),
            fullPage: true,
          });
        }
      }
      const token = mailToken(await guestMessages(dirname(config)));
      const recipient = await browser.newContext({ viewport: { width: 1000, height: 900 } });
      const publicPage = await recipient.newPage();
      const urls: string[] = [];
      const errors: string[] = [];
      publicPage.on("request", (request) => urls.push(request.url()));
      publicPage.on("pageerror", (error) => errors.push(error.message));
      const response = await publicPage.goto(`${base}/invite#token=${token}`);
      expect(response?.headers()["referrer-policy"]).toBe("no-referrer");
      expect(response?.headers()["cache-control"]).toBe("no-store");
      await publicPage
        .getByRole("button", { name: "Send verification code", exact: true })
        .waitFor();
      expect(new URL(publicPage.url()).hash).toBe("");
      expect(await publicPage.content()).not.toContain(token);
      expect(await publicPage.locator("body").textContent()).not.toContain(
        "recipient@example.test",
      );
      if (screenshots) {
        for (const colorScheme of ["light", "dark"] as const) {
          await publicPage.emulateMedia({ colorScheme });
          await publicPage.screenshot({
            path: join(screenshots, `invitation-public-${colorScheme}.png`),
            fullPage: true,
          });
        }
        await publicPage.setViewportSize({ width: 390, height: 844 });
        await publicPage.screenshot({
          path: join(screenshots, "invitation-public-mobile.png"),
          fullPage: true,
        });
      }
      await publicPage.getByRole("button", { name: "Send verification code", exact: true }).click();
      await publicPage.getByLabel("Verification code", { exact: true }).waitFor();
      const code = mailCode(await guestMessages(dirname(config)));
      await publicPage.getByLabel("Verification code", { exact: true }).fill(code);
      await publicPage.getByRole("checkbox").check();
      await publicPage.getByRole("button", { name: "Accept invitation", exact: true }).click();
      await publicPage.getByText("Invitation accepted", { exact: true }).waitFor();
      await publicPage.reload();
      await publicPage.getByText("Invitation accepted", { exact: true }).waitFor();
      await publicPage.goto(`${base}/invite/`);
      await publicPage.getByText("Invitation accepted", { exact: true }).waitFor();
      expect(
        urls.every(
          (url) =>
            new URL(url).origin === origin && !url.includes(token) && !url.includes("/events/live"),
        ),
      ).toBe(true);
      expect(errors).toEqual([]);
      expect(await tailnet.api.policy.get()).toEqual(before);
      const dimensions = await publicPage.evaluate(() => ({
        width: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(dimensions.width).toBeLessThanOrEqual(dimensions.viewport);
    } finally {
      try {
        await browser?.close();
      } finally {
        server.kill("SIGTERM");
        await stopped;
      }
    }
  },
);
