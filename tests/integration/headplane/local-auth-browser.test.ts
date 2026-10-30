import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { expect, test } from "vitest";

import { loadConfig } from "~/server/config/load";
import { createDbClient } from "~/server/db/client.server";
import { adminCommand } from "~/server/web/admin-cli";
import { createLocalAuthService } from "~/server/web/local-auth";

import { startHeadplane, writeHeadplaneConfig } from "../../harness/headplane";
import { freePort } from "../../harness/headscale";
import { createTailnet } from "../../harness/tailnet";
import { waitFor } from "../../harness/wait";

test.runIf(process.env.HP_LOCAL_AUTH_BROWSER === "1")(
  "Chromium local login, password change, logout and CSRF work with light, dark and mobile layouts",
  async () => {
    await using tailnet = await createTailnet();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}/console`;
    const configPath = await writeHeadplaneConfig(tailnet, {
      port,
      server: { base_path: "/console", base_url: `http://127.0.0.1:${port}` },
      auth: { local: { enabled: true } },
      integration: { docker: { enabled: false } },
    });
    const config = await loadConfig(configPath);
    const db = await createDbClient(join(config.server.data_path, "hp_persist.db"));
    const password = "browser test passphrase";
    const changedPassword = "changed browser test passphrase";
    try {
      expect(
        await adminCommand(
          createLocalAuthService(db, config.server.cookie_secret),
          ["create", "operations"],
          {
            text: async () => "Operations Administrator",
            secret: async () => password,
          },
        ),
      ).toBe("Administrator created.");
    } finally {
      db.$client.close();
    }
    const server = startHeadplane(configPath, port, { isProduction: true });
    const stopped = once(server, "exit");
    let browser: Browser | undefined;
    try {
      await waitFor("isolated local auth server", async () => {
        expect((await fetch(`${base}/healthz`)).ok).toBe(true);
      });
      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
      const errors: string[] = [];
      const responseChecks: Promise<void>[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("response", (response) => {
        const contentType = response.headers()["content-type"] ?? "";
        if (
          response.url().startsWith(base) &&
          /text\/html|text\/x-script|application\/json|javascript/.test(contentType)
        ) {
          responseChecks.push(
            response.text().then((body) => {
              expect(
                body.includes(tailnet.server.apiKey),
                "Headscale key leaked in browser response",
              ).toBe(false);
              expect(
                body.includes(config.server.cookie_secret),
                "Cookie secret leaked in browser response",
              ).toBe(false);
            }),
          );
        }
      });
      await page.goto(`${base}/login`);
      const screenshots = process.env.HP_LOCAL_AUTH_SCREENSHOTS;
      if (screenshots) await mkdir(screenshots, { recursive: true });
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `login-${colorScheme}.png`),
            fullPage: true,
          });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      if (screenshots)
        await page.screenshot({ path: join(screenshots, "login-mobile.png"), fullPage: true });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const refused = await page.request.post(`${base}/login`, {
        headers: { Origin: "https://attacker.test" },
        form: { method: "local", username: "operations", password },
      });
      expect(refused.status()).toBeGreaterThanOrEqual(400);
      const signIn = async (value: string) => {
        await page.getByLabel("Username", { exact: true }).fill("operations");
        await page.getByLabel("Password", { exact: true }).fill(value);
        await page.getByRole("button", { name: "Sign in", exact: true }).click();
      };
      await signIn("wrong browser passphrase");
      await page.getByText("Invalid credentials", { exact: true }).first().waitFor();
      await signIn(password);
      await page.waitForURL(`${base}/machines`);
      const cookies = await page.context().cookies();
      expect(cookies.find((c) => c.name === "_hp_auth")).toMatchObject({
        httpOnly: true,
        sameSite: "Lax",
        path: "/console",
      });
      // Resource routes must serve static JS/CSS from the built client directory.
      expect(errors).toEqual([]);
      await page.goto(`${base}/settings/account`);
      await page.getByText("Operations Administrator", { exact: true }).first().waitFor();
      for (const colorScheme of ["light", "dark"] as const) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.emulateMedia({ colorScheme });
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `account-${colorScheme}.png`),
            fullPage: true,
          });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      if (screenshots)
        await page.screenshot({ path: join(screenshots, "account-mobile.png"), fullPage: true });
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
      ).toBe(true);
      const crossSiteChange = await page.request.post(`${base}/settings/account`, {
        headers: { Origin: "https://attacker.test" },
        form: {
          intent: "change_password",
          current_password: password,
          new_password: changedPassword,
          confirm_password: changedPassword,
        },
      });
      expect(crossSiteChange.status()).toBeGreaterThanOrEqual(400);
      const crossSiteLogout = await page.request.post(`${base}/logout`, {
        headers: { Origin: "https://attacker.test" },
      });
      expect(crossSiteLogout.status()).toBe(403);
      await page.getByLabel("Current password", { exact: true }).fill(password);
      await page.getByLabel("New password", { exact: true }).fill(changedPassword);
      await page.getByLabel("Confirm new password", { exact: true }).fill(changedPassword);
      await page.getByRole("button", { name: "Change password", exact: true }).click();
      await page.waitForURL(`${base}/login`);
      await signIn(password);
      await page.getByText("Invalid credentials", { exact: true }).first().waitFor();
      await signIn(changedPassword);
      await page.waitForURL(`${base}/machines`);
      await page.request.post(`${base}/logout`, { headers: { Origin: new URL(base).origin } });
      await page.goto(`${base}/machines`);
      await page.waitForURL(`${base}/login`);
      await Promise.all(responseChecks);
      expect(errors).toEqual([]);
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
