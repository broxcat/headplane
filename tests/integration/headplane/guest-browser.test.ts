import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import { chromium, type Browser } from "playwright";
import { expect, test } from "vitest";

import { localDateTime } from "~/utils/guest-access";

import { startHeadplane, writeHeadplaneConfig } from "../../harness/headplane";
import { freePort } from "../../harness/headscale";
import { createTailnet } from "../../harness/tailnet";
import { waitFor } from "../../harness/wait";

// Opt in after pnpm build and pnpm exec playwright install chromium. This
// scenario exercises the real action transport, including its Origin guard.
test.runIf(process.env.HP_GUEST_BROWSER === "1")(
  "guest drafts work through the browser with a custom base path, both themes and a mobile viewport",
  async () => {
    await using tailnet = await createTailnet({ policy: '{"acls":[]}' });
    const policy = await tailnet.api.policy.get();
    const port = await freePort();
    const base = `http://127.0.0.1:${port}/console`;
    const config = await writeHeadplaneConfig(tailnet, {
      port,
      server: { base_path: "/console", base_url: `http://127.0.0.1:${port}` },
      guestInvitations: { enabled: true, transport: "file" },
      integration: { docker: { enabled: false } },
    });
    const server = startHeadplane(config, port, { isProduction: true });
    const stopped = once(server, "exit");
    let browser: Browser | undefined;

    try {
      browser = await chromium.launch({ headless: true });
      await waitFor("isolated Headplane server", async () => {
        expect((await fetch(`${base}/healthz`)).ok).toBe(true);
      });
      const page = await browser.newPage({
        viewport: { width: 1440, height: 1000 },
        timezoneId: "Europe/Paris",
      });
      const errors: string[] = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${base}/login`);
      await page.getByLabel("API key", { exact: true }).fill(tailnet.server.apiKey);
      await page.getByRole("button", { name: "Sign in with API key" }).click();
      await page.getByRole("link", { name: "Guests", exact: true }).click();
      await page.getByRole("heading", { name: "No guests yet" }).waitFor();

      // Same-origin transport accepts the form. A forged Origin must be refused
      // before it reaches an action, without creating another guest.
      const refused = await page.request.post(`${base}/guests`, {
        headers: { Origin: "https://unrelated.example" },
        form: { intent: "create", email: "cross-site@example.com", duration: "86400" },
      });
      expect(refused.status()).toBeGreaterThanOrEqual(400);

      await page.getByRole("button", { name: "Add Guest", exact: true }).click();
      expect(await page.getByLabel("Date", { exact: true }).count()).toBe(0);
      expect(await page.getByLabel("Time", { exact: true }).count()).toBe(0);
      await page.getByLabel("Email", { exact: true }).fill("alex@example.com");
      await page.getByLabel("Display name", { exact: true }).fill("Alex Morgan");
      await page
        .getByLabel("Administrative notes", { exact: true })
        .fill("Contractor request for the analytics project. No network access has been granted.");
      await page.getByRole("button", { name: "Create draft", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Add Guest", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "Alex Morgan", exact: true }).waitFor();
      await page.reload();
      await page.getByRole("link", { name: "Alex Morgan", exact: true }).waitFor();

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
            path: join(screenshots, `guests-${colorScheme}.png`),
            fullPage: true,
          });
      }
      expect(new Set(backgrounds).size).toBe(2);

      await page.getByRole("link", { name: "Alex Morgan", exact: true }).click();
      await page.getByText("12 hours", { exact: true }).waitFor();
      await page.getByText("VPN access not provisioned", { exact: true }).waitFor();
      expect(
        await page.getByRole("button", { name: "Revoke Access Now", exact: true }).count(),
      ).toBe(0);
      await page.getByRole("button", { name: "Edit draft", exact: true }).click();
      await page.getByLabel("Display name", { exact: true }).fill("Alex Morgan — vendor");
      const duration = page.getByRole("combobox", { name: "Access duration" });
      await duration.fill("Custom");
      await page.getByRole("option", { name: "Custom date", exact: true }).click();
      const plannedExpiry = new Date(Date.now() + 7 * 86400_000).toISOString().slice(0, 16);
      await page.getByText(/Time zone: Europe\/Paris/).waitFor();
      // The UTC-looking string is intentionally entered as local wall time.
      await page.getByLabel("Date", { exact: true }).fill(plannedExpiry.slice(0, 10));
      await page.getByLabel("Time", { exact: true }).fill(plannedExpiry.slice(11, 16));
      const localUtc = await page.evaluate(
        (value) => new Date(value).toISOString().slice(0, 16),
        plannedExpiry,
      );
      if (screenshots)
        await page.screenshot({
          animations: "disabled",
          path: join(screenshots, "access-duration-custom.png"),
          fullPage: true,
        });
      await page.getByRole("button", { name: "Save changes", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Edit guest draft", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByText(`${localUtc.replace("T", " ")} UTC`, { exact: true }).waitFor();
      await page.getByRole("heading", { name: "Alex Morgan — vendor", exact: true }).waitFor();
      // A different browser zone must display the same stored instant locally.
      const otherContext = await browser.newContext({
        timezoneId: "America/New_York",
        viewport: { width: 390, height: 844 },
        colorScheme: "dark",
        storageState: await page.context().storageState(),
      });
      const otherPage = await otherContext.newPage();
      await otherPage.goto(page.url());
      await otherPage.getByRole("button", { name: "Edit draft", exact: true }).click();
      const otherLocal = localDateTime(new Date(`${localUtc}Z`), "America/New_York");
      expect(await otherPage.getByLabel("Date", { exact: true }).inputValue()).toBe(
        otherLocal.slice(0, 10),
      );
      expect(await otherPage.getByLabel("Time", { exact: true }).inputValue()).toBe(
        otherLocal.slice(11, 16),
      );
      if (screenshots)
        await otherPage.screenshot({
          animations: "disabled",
          path: join(screenshots, "access-duration-custom-mobile.png"),
          fullPage: true,
        });
      await otherPage.getByRole("combobox", { name: "Access duration", exact: true }).fill("48");
      await otherPage.getByRole("option", { name: "48 hours", exact: true }).click();
      expect(await otherPage.getByLabel("Date", { exact: true }).count()).toBe(0);
      await otherPage.getByRole("button", { name: "Save changes", exact: true }).click();
      await otherPage
        .getByRole("dialog", { name: "Edit guest draft", exact: true })
        .waitFor({ state: "hidden" });
      await otherPage.getByText("48 hours", { exact: true }).waitFor();
      expect(await otherPage.getByText("Access expires at", { exact: true }).count()).toBe(0);
      await otherContext.close();
      await page.reload();
      await page.getByRole("button", { name: "Revoke draft", exact: true }).click();
      await page
        .getByRole("alertdialog")
        .getByRole("button", { name: "Revoke draft", exact: true })
        .click();
      await page.getByRole("alertdialog").waitFor({ state: "hidden" });
      await page
        .getByText("This draft was administratively revoked and can no longer be edited.")
        .waitFor();
      expect(await page.getByRole("button", { name: "Edit draft", exact: true }).count()).toBe(0);

      await page.getByRole("link", { name: "← Guests", exact: true }).click();
      await page.getByRole("searchbox", { name: "Search guests" }).fill("no-match@example.com");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await page.getByRole("heading", { name: "No matching guests" }).waitFor();
      await page.getByRole("link", { name: "Clear", exact: true }).click();
      await page.waitForURL((url) => url.pathname === "/console/guests" && url.search === "");
      await page.getByLabel("Status", { exact: true }).selectOption("revoked");
      await page.getByRole("button", { name: "Apply", exact: true }).click();
      await page.waitForURL((url) => url.searchParams.get("status") === "revoked");
      await page.getByRole("link", { name: "Alex Morgan — vendor", exact: true }).waitFor();
      expect(new URL(page.url()).searchParams.get("status")).toBe("revoked");
      expect(await page.getByText("cross-site@example.com", { exact: true }).count()).toBe(0);

      await page.setViewportSize({ width: 390, height: 844 });
      if (screenshots)
        await page.screenshot({ path: join(screenshots, "guests-mobile.png"), fullPage: true });
      const dimensions = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        viewport: window.innerWidth,
      }));
      expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.viewport);
      await page.goto(`${base}/settings/guest-email`);
      await page
        .getByText(
          "Development file transport: messages stay on this server. No external email is sent.",
          { exact: true },
        )
        .waitFor();
      const crossSite = await page.request.post(`${base}/settings/guest-email`, {
        headers: { Origin: "https://unrelated.example" },
        form: { intent: "check_connection" },
      });
      expect(crossSite.status()).toBeGreaterThanOrEqual(400);
      await page.getByRole("button", { name: "Check connection", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Check email connection?", exact: true })
        .getByRole("button", { name: "Check connection", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Check email connection?", exact: true })
        .waitFor({ state: "hidden" });
      expect(errors).toEqual([]);
      expect(await tailnet.api.policy.get()).toEqual(policy);
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
