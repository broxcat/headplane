import { expect, test } from "vitest";

import { loader as layout } from "~/layout/app";
import { action as login, loader as loginPage } from "~/routes/auth/login/page";
import { action as logout } from "~/routes/auth/logout";
import { loader as home } from "~/routes/home";
import { action as changePassword, loader as account } from "~/routes/settings/account";
import { adminCommand } from "~/server/web/admin-cli";

import { createTailnet } from "../../harness/tailnet";
import { testedVersions } from "../../harness/versions";
import { statusOf } from "../../support/app";

const PASSWORD = "local integration passphrase";
const NEW_PASSWORD = "changed integration passphrase";
const sessionCookie = (result: unknown) => {
  expect(result).toBeInstanceOf(Response);
  return (result as Response).headers.get("Set-Cookie")!.split(";")[0];
};

test.for(testedVersions())(
  "local administrator lifecycle coexists with API key authentication on Headscale %s",
  async (version) => {
    await using tailnet = await createTailnet({ version });
    const app = await tailnet.headplane({ config: { auth: { local: { enabled: true } } } });
    expect(await app.call(loginPage, "/login")).toMatchObject({ isLocalEnabled: false });
    const prompt = { text: async () => "Local Administrator", secret: async () => PASSWORD };
    expect(await adminCommand(app.ctx.localAuth, ["create", "localadmin"], prompt)).toBe(
      "Administrator created.",
    );
    expect(await app.call(loginPage, "/login")).toMatchObject({ isLocalEnabled: true });
    const signIn = (password: string) =>
      app.call(login, "/login", { form: { method: "local", username: "LOCALADMIN", password } });
    const cookie = sessionCookie(await signIn(PASSWORD));
    expect(await app.call(home, "/", { as: cookie })).toMatchObject({ status: 302 });
    const page = await app.call(layout, "/machines", { as: cookie });
    expect(statusOf(page)).toBe(200);
    expect(JSON.stringify(page)).not.toContain(tailnet.server.apiKey);
    expect(await app.call(account, "/settings/account", { as: cookie })).toEqual({
      method: "local_admin",
      username: "localadmin",
      displayName: "Local Administrator",
    });
    const other = sessionCookie(await signIn(PASSWORD));
    expect(
      statusOf(
        await app.call(changePassword, "/settings/account", {
          as: cookie,
          headers: { Origin: "https://attacker.test" },
          form: {
            intent: "change_password",
            current_password: PASSWORD,
            new_password: NEW_PASSWORD,
            confirm_password: NEW_PASSWORD,
          },
        }),
      ),
    ).toBe(403);
    expect(
      statusOf(
        await app.call(changePassword, "/settings/account", {
          as: cookie,
          form: {
            intent: "change_password",
            current_password: PASSWORD,
            new_password: NEW_PASSWORD,
            confirm_password: NEW_PASSWORD,
          },
        }),
      ),
    ).toBe(302);
    await expect(app.ctx.auth.require(app.request("/", { as: other }))).rejects.toThrow();
    expect(statusOf(await signIn(PASSWORD))).toBe(400);
    const changed = sessionCookie(await signIn(NEW_PASSWORD));
    expect(statusOf(await app.call(logout, "/logout", { as: changed, form: {} }))).toBe(302);
    await expect(app.ctx.auth.require(app.request("/", { as: changed }))).rejects.toThrow();
    const disabled = sessionCookie(await signIn(NEW_PASSWORD));
    app.ctx.localAuth.setEnabled("localadmin", false);
    await expect(app.ctx.auth.require(app.request("/", { as: disabled }))).rejects.toThrow();
    expect(statusOf(await signIn(NEW_PASSWORD))).toBe(403); // No active local accounts remain.
    app.ctx.localAuth.setEnabled("localadmin", true);
    expect(
      await adminCommand(app.ctx.localAuth, ["reset-password", "localadmin"], prompt),
    ).toContain("Password reset");
    expect(statusOf(await signIn(NEW_PASSWORD))).toBe(400);
    const recovered = sessionCookie(await signIn(PASSWORD));
    expect((await app.ctx.auth.require(app.request("/", { as: recovered }))).kind).toBe(
      "local_admin",
    );
    const apiCookie = sessionCookie(
      await app.call(login, "/login", { form: { api_key: tailnet.server.apiKey } }),
    );
    expect((await app.ctx.auth.require(app.request("/", { as: apiCookie }))).kind).toBe("api_key");
    for (let i = 0; i < 5; i++) expect(statusOf(await signIn("wrong long passphrase"))).toBe(400);
    expect(statusOf(await signIn(PASSWORD))).toBe(429);
  },
);
