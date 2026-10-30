import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { startHeadplane, writeHeadplaneConfig } from "../../harness/headplane";
import { freePort } from "../../harness/headscale";
import { createTailnet } from "../../harness/tailnet";
import { waitFor } from "../../harness/wait";

test.runIf(process.env.HP_GUEST_BROWSER === "1")(
  "resource selection, preview, CSRF and responsive themes work through the real browser transport",
  async () => {
    await using tailnet = await createTailnet({
      policy: '{"acls":[{"action":"accept","src":["*"],"dst":["*:*"]}]}',
    });
    const router = await tailnet.node({
      name: "analytics-server",
      user: "operations",
      routes: ["10.44.0.0/24"],
    });
    await tailnet.api.nodes.approveRoutes(router.id, ["10.44.0.0/24"]);
    const policy = await tailnet.api.policy.get();
    const users = await tailnet.api.users.list();
    const port = await freePort();
    const origin = `http://127.0.0.1:${port}`;
    const base = `${origin}/console`;
    const config = await writeHeadplaneConfig(tailnet, {
      port,
      server: { base_path: "/console", base_url: origin },
      integration: { docker: { enabled: false } },
    });
    const server = startHeadplane(config, port, { isProduction: true });
    const stopped = once(server, "exit");
    const browser = await chromium.launch({ headless: true });
    try {
      await waitFor("resource test server", async () =>
        expect((await fetch(`${base}/healthz`)).ok).toBe(true),
      );
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
      const errors: string[] = [];
      page.on("pageerror", (e) => errors.push(e.message));
      await page.goto(`${base}/login`);
      await page.getByLabel("API key", { exact: true }).fill(tailnet.server.apiKey);
      await page.getByRole("button", { name: "Sign in with API key" }).click();
      await page.getByRole("link", { name: "Guests", exact: true }).click();
      await page.getByRole("button", { name: "Add Guest", exact: true }).click();
      await page.getByLabel("Email", { exact: true }).fill("visitor@example.com");
      await page.getByLabel("Display name", { exact: true }).fill("Visitor Access");
      await page.getByRole("checkbox", { name: /analytics-server/ }).check();
      await page.getByLabel("Ports for resource 1", { exact: true }).fill("3000,8000-8010");
      await page.getByRole("button", { name: "Create draft", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Add Guest", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "Visitor Access", exact: true }).click();
      await page.getByText("Existing policy conflict", { exact: true }).waitFor();
      await page.getByText("VPN access not provisioned", { exact: true }).waitFor();
      const id = new URL(page.url()).pathname.split("/").at(-1)!;
      const refused = await page.request.post(`${base}/guests/${id}`, {
        headers: { Origin: "https://unrelated.example" },
        form: { intent: "save_resources", revision: "1", resources: "[]" },
      });
      expect(refused.status()).toBeGreaterThanOrEqual(400);
      await page.reload();
      const screenshots = process.env.HP_GUEST_SCREENSHOTS;
      if (screenshots) await mkdir(screenshots, { recursive: true });
      const backgrounds: string[] = [];
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        backgrounds.push(
          await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
        );
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `guest-resources-${colorScheme}.png`),
            fullPage: true,
          });
      }
      expect(new Set(backgrounds).size).toBe(2);
      await page.getByRole("button", { name: "Edit allowed resources", exact: true }).click();
      await page.getByLabel("Ports for resource 1", { exact: true }).fill("443");
      await page.getByText("Declare a LAN service", { exact: true }).click();
      const route = page.getByLabel("Subnet route", { exact: true });
      await route.selectOption(`${router.id}|10.44.0.0/24`);
      await page.getByLabel("LAN IP address", { exact: true }).fill("10.44.0.8");
      await page.getByRole("button", { name: "Add LAN service", exact: true }).click();
      await page.getByLabel("Ports for resource 2", { exact: true }).fill("8006");
      await page.setViewportSize({ width: 390, height: 844 });
      if (screenshots)
        await page.screenshot({
          path: join(screenshots, "guest-resources-mobile.png"),
          fullPage: true,
        });
      await page.getByRole("button", { name: "Save resource intentions", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Edit allowed resources", exact: true })
        .waitFor({ state: "hidden" });
      await page.reload();
      await page.getByText(/LAN service.*10\.44\.0\.8/).waitFor();
      expect(
        await page
          .getByRole("button", { name: /Apply ACL|Revoke Guest Access|Revoke Device/ })
          .count(),
      ).toBe(0);
      expect(errors).toEqual([]);
      expect(await tailnet.api.policy.get()).toEqual(policy);
      expect(await tailnet.api.users.list()).toEqual(users);
      expect((await tailnet.api.nodes.list()).map((n) => n.id)).toEqual([router.id]);
    } finally {
      await browser.close();
      server.kill("SIGTERM");
      await stopped;
    }
  },
);
