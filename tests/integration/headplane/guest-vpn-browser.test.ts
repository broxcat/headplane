import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";

import { chromium } from "playwright";
import { expect, test } from "vitest";

import { startHeadplane, writeHeadplaneConfig } from "../../harness/headplane";
import { freePort } from "../../harness/headscale";
import { waitFor } from "../../harness/wait";
import { guestMessages, mailCode, mailToken } from "../../support/guest-mail";
import {
  createGuestTailnet as createTailnet,
  guestBuildApprovals,
} from "../../support/guest-tailnet";

test.runIf(process.env.HP_GUEST_BROWSER === "1")(
  "Guest email verification, isolated device onboarding, revoke and responsive themes through browser HTTP",
  async () => {
    await using tailnet = await createTailnet({ policy: { grants: [] } });
    const resource = await tailnet.node({
      name: "guest-resource-server",
      user: "browser-operator",
    });
    await resource.serveHttp(8006);
    const address = (await resource.machine()).ipAddresses[0];
    const port = await freePort(),
      origin = `http://127.0.0.1:${port}`,
      base = `${origin}/console`;
    const config = await writeHeadplaneConfig(tailnet, {
      port,
      server: { base_path: "/console", base_url: origin },
      integration: { docker: { enabled: false } },
      guestInvitations: { enabled: true, transport: "file" },
      guestVpn: { enabled: true, single_policy_writer: true },
      headscale: { compatibility: { approved_builds: await guestBuildApprovals() } },
    });
    let server = startHeadplane(config, port, { isProduction: true });
    let stopped = once(server, "exit");
    const browser = await chromium.launch({ headless: true });
    try {
      await waitFor("Guest VPN browser server", async () =>
        expect((await fetch(`${base}/healthz`)).ok).toBe(true),
      );
      const page = await browser.newPage({ viewport: { width: 1440, height: 1100 } });
      await page.goto(`${base}/login`);
      await page.getByLabel("API key", { exact: true }).fill(tailnet.server.apiKey);
      await page.getByRole("button", { name: "Sign in with API key" }).click();
      await page.getByRole("link", { name: "Guests", exact: true }).click();
      await page.getByRole("button", { name: "Add Guest", exact: true }).click();
      await page.getByLabel("Email", { exact: true }).fill("vpn-browser@example.test");
      await page.getByLabel("Display name", { exact: true }).fill("Visiting engineer");
      await page.getByRole("checkbox", { name: /guest-resource-server/ }).check();
      await page.getByLabel("Ports for resource 1", { exact: true }).fill("8006");
      await page.getByRole("button", { name: "Create draft", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Add Guest", exact: true })
        .waitFor({ state: "hidden" });
      await page.getByRole("link", { name: "Visiting engineer", exact: true }).click();
      await page.getByRole("heading", { name: "Visiting engineer", exact: true }).waitFor();
      const guestUrl = page.url();
      await page.getByRole("button", { name: "Send Invitation", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Send invitation?" })
        .getByRole("button", { name: "Send invitation", exact: true })
        .click();
      await page.getByRole("dialog", { name: "Send invitation?" }).waitFor({ state: "hidden" });
      const token = mailToken(await guestMessages(dirname(config)));
      const guestContext = await browser.newContext();
      const guest = await guestContext.newPage();
      await guest.addInitScript((value) => {
        if (location.pathname.endsWith("/invite") && !sessionStorage.getItem("invitation-opened")) {
          sessionStorage.setItem("invitation-opened", "yes");
          history.replaceState(history.state, "", `${location.pathname}#token=${value}`);
        }
      }, token);
      await guest.goto(`${base}/invite`);
      await guest.getByRole("button", { name: "Send verification code", exact: true }).click();
      await guest.getByLabel("Verification code", { exact: true }).waitFor();
      await guest
        .getByLabel("Verification code", { exact: true })
        .fill(mailCode(await guestMessages(dirname(config))));
      await guest.getByRole("checkbox").check();
      await guest.getByRole("button", { name: "Accept invitation", exact: true }).click();
      await guest.getByRole("link", { name: "Continue to device onboarding" }).waitFor();
      // Recover an accepted response whose scoped cookie was lost. The recent
      // verified invitation session may exchange again without replaying OTP.
      await guestContext.clearCookies({ name: "_hp_guest_vpn" });
      await guest.reload();
      expect((await guestContext.cookies()).some((cookie) => cookie.name === "_hp_guest_vpn")).toBe(
        true,
      );
      await page.reload();
      await page.getByRole("button", { name: "Provision Access", exact: true }).click();
      await page
        .getByRole("dialog", { name: "Provision guest access?" })
        .getByRole("button", { name: "Provision Access", exact: true })
        .click();
      await page
        .getByRole("dialog", { name: "Provision guest access?" })
        .waitFor({ state: "hidden" });
      await guest.getByRole("link", { name: "Continue to device onboarding" }).click();
      await guest.getByRole("heading", { name: "Guest device onboarding" }).waitFor();
      await guest.getByLabel("Auth ID", { exact: true }).waitFor();
      const security = await guest.request.post(`${base}/guest-access`, {
        headers: { Origin: "https://wrong-origin.test" },
        form: { intent: "register", auth_id: "not-a-secret", csrf: "invalid" },
      });
      // React Router rejects the foreign Origin with 400 before route actions;
      // direct action calls exercise the explicit 403 guard separately.
      expect([400, 403]).toContain(security.status());
      const noSession = await fetch(`${base}/guest-access`);
      expect(noSession.status).toBe(401);
      expect(noSession.headers.get("cache-control")).toBe("no-store");
      const pending = await tailnet.pendingNode({ name: "browser-guest-device" });
      await guest
        .getByLabel("Auth ID", { exact: true })
        .fill(pending.registerUrl.split("/register/")[1]);
      await guest.getByRole("button", { name: "Register my device" }).click();
      await guest.getByText("VPN access active", { exact: true }).waitFor();
      const device = await pending.joined();
      await waitFor("browser guest TCP access", async () =>
        expect(await device.canConnect(address, 8006)).toBe(true),
      );
      server.kill("SIGTERM");
      await stopped;
      server = startHeadplane(config, port, { isProduction: true });
      stopped = once(server, "exit");
      await waitFor("restarted Guest VPN browser server", async () =>
        expect((await fetch(`${base}/healthz`)).ok).toBe(true),
      );
      await guest.reload();
      await guest.getByText("VPN access active", { exact: true }).waitFor();
      await page.goto(guestUrl);
      await page.getByRole("button", { name: "Revoke Access Now", exact: true }).waitFor();
      const screenshots = globalThis.process.env.HP_GUEST_SCREENSHOTS;
      if (screenshots) await mkdir(screenshots, { recursive: true });
      const backgrounds: string[] = [];
      for (const colorScheme of ["light", "dark"] as const) {
        await page.emulateMedia({ colorScheme });
        backgrounds.push(
          await page.evaluate(() => getComputedStyle(document.documentElement).backgroundColor),
        );
        if (screenshots)
          await page.screenshot({
            path: join(screenshots, `guest-vpn-${colorScheme}.png`),
            fullPage: true,
          });
      }
      expect(new Set(backgrounds).size).toBe(2);
      await page.setViewportSize({ width: 390, height: 844 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      );
      if (screenshots)
        await page.screenshot({ path: join(screenshots, "guest-vpn-mobile.png"), fullPage: true });
      await page.getByRole("button", { name: "Revoke Access Now", exact: true }).click();
      await page
        .getByRole("alertdialog", { name: "Revoke guest access now?" })
        .getByRole("button", { name: "Revoke Access Now", exact: true })
        .click();
      await page
        .getByRole("alertdialog", { name: "Revoke guest access now?" })
        .waitFor({ state: "hidden" });
      await page.getByText("revoked", { exact: true }).waitFor();
      await waitFor("browser guest revocation", async () =>
        expect(await device.canConnect(address, 8006)).toBe(false),
      );
      await guest.reload();
      expect(await guest.getByLabel("Auth ID", { exact: true }).count()).toBe(0);
      expect((await fetch(`${base}/assets/guest-vpn.js.map`)).status).toBe(404);
      await guestContext.close();
    } catch (error) {
      throw new Error(
        String(error).replace(
          /hskey-[A-Za-z0-9_-]+|[A-Za-z0-9_-]{43}|\b\d{8}\b/g,
          "[credential redacted]",
        ),
      );
    } finally {
      await browser.close();
      server.kill("SIGTERM");
      await stopped;
    }
  },
);
