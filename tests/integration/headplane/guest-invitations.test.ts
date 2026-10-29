import { readFile } from "node:fs/promises";

import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

import { loader as publicLoader, action as publicAction } from "~/routes/guests/accept";
import { action as edit, loader as detail } from "~/routes/guests/detail";
import { action as create, loader as list } from "~/routes/guests/overview";
import { guestInvitations } from "~/server/db/schema";

import { createTailnet, type Tailnet } from "../../harness/tailnet";
import { testedVersions } from "../../harness/versions";
import { statusOf, type TestApp } from "../../support/app";
import { guestMessages, mailToken, mailCode } from "../../support/guest-mail";

interface ResponseData {
  init?: { headers?: HeadersInit };
  data: Record<string, unknown>;
}
const body = (result: unknown) => (result as ResponseData).data;
const cookieFrom = (result: unknown) =>
  new Headers((result as ResponseData).init?.headers).get("Set-Cookie")?.split(";")[0];
const origin = "http://localhost:3099";

describe.for(testedVersions())("guest invitations alongside Headscale %s", (version) => {
  let tailnet: Tailnet;
  let app: TestApp;
  let admin: string;
  let sequence = 0;

  beforeAll(async () => {
    tailnet = await createTailnet({ version, policy: { acls: [] } });
    app = await tailnet.headplane({
      config: {
        server: { base_path: "/guest-console", base_url: origin },
        guest_invitations: { enabled: true, transport: "file", max_validity_hours: 48 },
      },
    });
    admin = (await app.signIn("owner")).cookie;
  });
  afterAll(async () => {
    await tailnet?.dispose();
  });

  async function draft() {
    const created = await app.call(create, "/guests", {
      as: admin,
      form: {
        intent: "create",
        email: `invited-${++sequence}@example.test`,
        display_name: "Invited guest",
        duration: "86400",
      },
    });
    expect(statusOf(created)).toBe(200);
    const id = String(body(created).id);
    return id;
  }
  function revision(id: string) {
    const guest = app.ctx.guests.get(id);
    if (!guest.ok) throw new Error(guest.error.message);
    return String(guest.value.revision);
  }
  function send(id: string) {
    return app.call(edit, `/guests/${id}`, {
      as: admin,
      params: { id },
      form: { intent: "send_invitation", revision: revision(id), validity_hours: "24" },
    });
  }
  async function open(cookie?: string) {
    const result = await app.call(publicLoader, "/invite", { as: cookie });
    expect(statusOf(result)).toBe(200);
    return {
      cookie: cookieFrom(result) ?? cookie!,
      csrf: String(body(result).csrf),
      stage: body(result).stage,
      result,
    };
  }
  async function post(
    session: { cookie: string; csrf: string },
    form: Record<string, string>,
    headers: Record<string, string> = { origin },
  ) {
    return app.call(publicAction, "/invite", {
      as: session.cookie,
      headers,
      form: { ...form, csrf: session.csrf },
    });
  }
  async function exchange(token: string) {
    const initial = await open();
    const result = await post(initial, { intent: "exchange", token });
    expect(statusOf(result)).toBe(200);
    const cookie = cookieFrom(result)!;
    expect(cookie).not.toBe(initial.cookie);
    return open(cookie);
  }
  async function messages() {
    return guestMessages(app.ctx.config.server.data_path);
  }

  test("an administrator sends an invitation and a verified recipient accepts exactly once without changing Headscale", async () => {
    const before = {
      policy: await tailnet.api.policy.get(),
      users: await tailnet.api.users.list(),
      nodes: await tailnet.api.nodes.list(),
      config: await readFile(tailnet.server.configPath, "utf8"),
    };
    const id = await draft();
    expect(statusOf(await send(id))).toBe(200);
    const token = mailToken(await messages());
    expect(await app.call(list, "/guests", { as: admin, search: "?status=pending" })).toMatchObject(
      {
        rows: expect.arrayContaining([
          expect.objectContaining({ id, invitation_status: "pending" }),
        ]),
      },
    );
    expect(await app.call(detail, `/guests/${id}`, { as: admin, params: { id } })).toMatchObject({
      invitation: { status: "pending", send_count: 1 },
    });
    const session = await exchange(token);
    expect(session.stage).toBe("verify");
    const head = new Headers((session.result as ResponseData).init?.headers);
    expect(head.get("cache-control")).toBe("no-store");
    expect(head.get("referrer-policy")).toBe("no-referrer");
    expect(
      statusOf(await post(session, { intent: "accept", code: "00000000", consent: "yes" })),
    ).toBe(400);
    expect(statusOf(await post(session, { intent: "send_code" }))).toBe(200);
    const code = mailCode(await messages());
    expect(statusOf(await post(session, { intent: "accept", code }))).toBe(400);
    const results = await Promise.all([
      post(session, { intent: "accept", code, consent: "yes" }),
      post(session, { intent: "accept", code, consent: "yes" }),
    ]);
    expect(results.map(statusOf).sort()).toEqual([200, 400]);
    expect((await open(session.cookie)).stage).toBe("accepted");
    expect(await app.call(detail, `/guests/${id}`, { as: admin, params: { id } })).toMatchObject({
      invitation: { status: "accepted" },
      guest: { activated_at: null, expires_at: null },
    });
    const newBrowser = await open();
    expect(statusOf(await post(newBrowser, { intent: "exchange", token }))).toBe(400);
    expect(await tailnet.api.policy.get()).toEqual(before.policy);
    expect(await tailnet.api.users.list()).toEqual(before.users);
    expect(await tailnet.api.nodes.list()).toEqual(before.nodes);
    expect(await readFile(tailnet.server.configPath, "utf8")).toBe(before.config);
  });

  test("revoked, expired and fabricated links produce the same public failure and cannot be accepted", async () => {
    const tokens: string[] = [];
    const revoked = await draft();
    expect(statusOf(await send(revoked))).toBe(200);
    tokens.push(mailToken(await messages()));
    expect(
      statusOf(
        await app.call(edit, `/guests/${revoked}`, {
          as: admin,
          params: { id: revoked },
          form: { intent: "revoke", revision: revision(revoked) },
        }),
      ),
    ).toBe(200);
    const expired = await draft();
    expect(statusOf(await send(expired))).toBe(200);
    tokens.push(mailToken(await messages()));
    app.ctx.db
      .update(guestInvitations)
      .set({ issued_at: new Date(Date.now() - 7200_000), expires_at: new Date(Date.now() - 1000) })
      .where(eq(guestInvitations.guest_id, expired))
      .run();
    tokens.push("a".repeat(43));
    const errors: unknown[] = [];
    for (const token of tokens) {
      const session = await open();
      const result = await post(session, { intent: "exchange", token });
      expect(statusOf(result)).toBe(400);
      errors.push(body(result).error);
    }
    expect(new Set(errors).size).toBe(1);
    expect(
      await app.call(detail, `/guests/${expired}`, { as: admin, params: { id: expired } }),
    ).toMatchObject({
      invitation: { status: "expired" },
      events: expect.arrayContaining([expect.objectContaining({ kind: "expired" })]),
    });
  });

  test("a resend rotates the link and sessions and direct cross-site or CSRF-free POSTs are refused", async () => {
    const id = await draft();
    expect(statusOf(await send(id))).toBe(200);
    const token = mailToken(await messages());
    const session = await exchange(token);
    expect(
      statusOf(await post(session, { intent: "send_code" }, { origin: "https://attacker.test" })),
    ).toBe(403);
    expect(statusOf(await post({ ...session, csrf: "invalid" }, { intent: "send_code" }))).toBe(
      403,
    );
    expect(statusOf(await post(session, { intent: "send_code" }, {}))).toBe(403);
    app.ctx.db
      .update(guestInvitations)
      .set({ delivery_started_at: new Date(Date.now() - 61_000) })
      .where(eq(guestInvitations.guest_id, id))
      .run();
    expect(statusOf(await send(id))).toBe(200);
    expect((await open(session.cookie)).stage).toBe("start");
    const initial = await open();
    expect(statusOf(await post(initial, { intent: "exchange", token }))).toBe(400);
    expect((await exchange(mailToken(await messages()))).stage).toBe("verify");
  });

  test.for(["admin", "network_admin", "it_admin", "auditor", "viewer", "member"] as const)(
    "%s has only its expected invitation administration permissions",
    async (role) => {
      const id = await draft();
      const as = (await app.signIn(role)).cookie;
      const result = await app.call(edit, `/guests/${id}`, {
        as,
        params: { id },
        form: { intent: "send_invitation", revision: revision(id), validity_hours: "24" },
      });
      expect(statusOf(result)).toBe(role === "admin" ? 200 : 403);
      expect(statusOf(await app.call(detail, `/guests/${id}`, { as, params: { id } }))).toBe(
        role === "admin" ? 200 : 403,
      );
    },
  );
});
