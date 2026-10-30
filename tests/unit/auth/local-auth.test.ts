import { argon2id, argon2Verify } from "hash-wasm";
import { afterEach, expect, test, vi } from "vitest";

import { authSessions, localAdminUsers, localAuthEvents, users } from "~/server/db/schema";
import { adminCommand } from "~/server/web/admin-cli";
import { requireSameOrigin } from "~/server/web/csrf";
import { createLocalAuthService, normalizeUsername } from "~/server/web/local-auth";
import { hashPassword, validPassword, verifyPassword } from "~/server/web/passwords";
import { Capabilities } from "~/server/web/roles";

import { createTestAuth } from "./create-auth";

const PASSWORD = "a long test passphrase";
const NEW_PASSWORD = "another long test passphrase";
const connections: ReturnType<typeof createTestAuth>["db"][] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const db of connections.splice(0)) db.$client.close();
});

function setup(localEnabled = true, secure = false) {
  const { auth, db } = createTestAuth({
    headscaleApiKey: "server-only-headscale-test-credential",
    localEnabled,
    cookie: { secure },
  });
  connections.push(db);
  const local = createLocalAuthService(db, "unit-local-auth-secret");
  const request = (cookie: string) =>
    new Request("https://headplane.test/admin", { headers: { cookie: cookie.split(";")[0] } });
  async function login(username = "Alice", password = PASSWORD) {
    const result = await local.authenticate(username, password);
    if (!result.ok) throw new Error(result.error);
    const cookie = await auth.createLocalSession(result.value.userId, result.value.revision);
    if (!cookie) throw new Error("No session");
    return cookie;
  }
  return { auth, db, local, login, request };
}

test("usernames are ASCII-only and case-independent; passphrases are never truncated or normalized", () => {
  expect(normalizeUsername("Alice.Admin-1")).toBe("alice.admin-1");
  for (const username of [
    "ab",
    " admin",
    "admin ",
    "аdmin",
    "Ａdmin",
    "a@b",
    "a\n",
    "admin\n",
    "admin\r",
    "a".repeat(65),
  ])
    expect(normalizeUsername(username)).toBeUndefined();
  expect(validPassword("x".repeat(11))).toBe(false);
  expect(validPassword("🔒".repeat(12))).toBe(true);
  expect(validPassword("x".repeat(256))).toBe(true);
  expect(validPassword("x".repeat(257))).toBe(false);
});

test("Argon2id PHC hashes have independent salts and interoperate with the WASM implementation", async () => {
  const first = await hashPassword(PASSWORD);
  expect(first).toMatch(/^\$argon2id\$v=19\$m=65536,t=3,p=1\$/);
  expect(await hashPassword(PASSWORD)).not.toBe(first);
  expect(await argon2Verify({ password: PASSWORD, hash: first })).toBe(true);
  expect(await verifyPassword(first, PASSWORD)).toEqual({ valid: true, rehash: false });
  expect((await verifyPassword(first, `${PASSWORD} `)).valid).toBe(false);
  const old = await argon2id({
    password: PASSWORD,
    salt: "12345678abcdefgh",
    memorySize: 19456,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: "encoded",
  });
  expect(await verifyPassword(old, PASSWORD)).toEqual({ valid: true, rehash: true });
  expect((await verifyPassword(first.replace("m=65536", "m=999999999"), PASSWORD)).valid).toBe(
    false,
  );
});

test("server bootstrap creates one RBAC admin, refuses case duplicates and never stores the password", async () => {
  const { local, db } = setup();
  expect(local.available()).toBe(false);
  const created = await local.create("Alice", "Alice Admin", PASSWORD);
  expect(created.ok).toBe(true);
  expect((await local.create("ALICE", "Duplicate", PASSWORD)).ok).toBe(false);
  expect((await local.create("other", "Other", "short")).ok).toBe(false);
  expect(local.list()).toMatchObject([{ username: "Alice", role: "admin", enabled: true }]);
  expect(JSON.stringify(db.select().from(localAdminUsers).all())).not.toContain(PASSWORD);
  expect(db.select().from(users).all()).toMatchObject([{ role: "admin" }]);
});

test("unknown, wrong-password and disabled logins are refused; login upgrades old Argon2 costs", async () => {
  const { local, db } = setup();
  await local.create("Alice", "Alice", PASSWORD);
  expect(await local.authenticate("unknown", PASSWORD)).toEqual({ ok: false, error: "invalid" });
  expect(await local.authenticate("Alice", NEW_PASSWORD)).toEqual({ ok: false, error: "invalid" });
  const old = await argon2id({
    password: PASSWORD,
    salt: "12345678abcdefgh",
    memorySize: 19456,
    iterations: 2,
    parallelism: 1,
    hashLength: 32,
    outputType: "encoded",
  });
  db.update(localAdminUsers).set({ password_hash: old }).run();
  expect((await local.authenticate("alice", PASSWORD)).ok).toBe(true);
  expect(db.select().from(localAdminUsers).get()?.password_hash).toContain("m=65536,t=3,p=1");
  local.setEnabled("Alice", false);
  expect(await local.authenticate("Alice", PASSWORD)).toEqual({ ok: false, error: "invalid" });
});

test("account locks persist across services and blocked requests do not extend them", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { local, db } = setup();
  await local.create("Alice", "Alice", PASSWORD);
  for (let i = 0; i < 5; i++)
    expect((await local.authenticate("Alice", NEW_PASSWORD, `192.0.2.${i}`)).ok).toBe(false);
  const refusedEvents = db.select().from(localAuthEvents).all().length;
  for (let i = 0; i < 100; i++) await local.authenticate("Alice", PASSWORD);
  expect(db.select().from(localAuthEvents).all().length).toBe(refusedEvents + 1);
  const restarted = createLocalAuthService(db, "unit-local-auth-secret");
  expect(await restarted.authenticate("ALICE", PASSWORD)).toEqual({ ok: false, error: "limited" });
  vi.setSystemTime(Date.now() + 1001);
  expect((await restarted.authenticate("alice", PASSWORD)).ok).toBe(true);
  // Successful authentication clears the account penalty.
  expect((await restarted.authenticate("alice", PASSWORD)).ok).toBe(true);
});

test("address and global budgets bound password spraying across usernames", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { local, db } = setup();
  for (let i = 0; i < 20; i++)
    expect((await local.authenticate(`unknown${i}`, PASSWORD, "192.0.2.1")).ok).toBe(false);
  expect(await local.authenticate("another", PASSWORD, "192.0.2.1")).toEqual({
    ok: false,
    error: "limited",
  });
  for (let i = 20; i < 60; i++) await local.authenticate(`unknown${i}`, PASSWORD, `192.0.2.${i}`);
  expect(await local.authenticate("another", PASSWORD, "192.0.2.250")).toEqual({
    ok: false,
    error: "limited",
  });
  vi.setSystemTime(Date.now() + 60_001);
  expect(
    await createLocalAuthService(db, "unit-local-auth-secret").authenticate(
      "another",
      PASSWORD,
      "192.0.2.1",
    ),
  ).toEqual({ ok: false, error: "invalid" });
}, 20_000);

test("local sessions contain only a session ID, follow cookie_max_age and use the existing RBAC", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const { local, auth, db, login, request } = setup(true, true);
  await local.create("Alice", "Alice Admin", PASSWORD);
  const cookie = await login();
  expect(cookie).toContain("HttpOnly");
  expect(cookie).toContain("Secure");
  expect(cookie).toContain("SameSite=Lax");
  expect(cookie).toContain("Max-Age=3600");
  const raw = decodeURIComponent(cookie.split(";")[0].split("=").slice(1).join("="));
  // React Router's cookie serialization adds a base64 wrapper around the value.
  const signed = JSON.parse(Buffer.from(raw, "base64").toString());
  expect(
    Object.keys(JSON.parse(Buffer.from(signed.split(".")[0], "base64url").toString())),
  ).toEqual(["sid"]);
  const principal = await auth.require(request(cookie));
  expect(principal).toMatchObject({
    kind: "local_admin",
    user: { role: "admin" },
    profile: { username: "Alice" },
  });
  expect(auth.can(principal, Capabilities.manage_guests)).toBe(true);
  expect(auth.can(principal, Capabilities.owner)).toBe(false);
  if (principal.kind !== "local_admin") throw new Error("Expected local identity");
  await auth.reassignUser(principal.user.id, "viewer");
  expect(auth.can(await auth.require(request(cookie)), Capabilities.manage_guests)).toBe(false);
  await auth.reassignUser(principal.user.id, "admin");
  expect(auth.getHeadscaleApiKey(principal)).toBe("server-only-headscale-test-credential");
  expect(JSON.stringify(principal)).not.toContain("server-only");
  expect(db.select().from(authSessions).get()?.api_key_hash).toBeNull();
  await auth.destroySession(request(cookie));
  await expect(auth.require(request(cookie))).rejects.toThrow("Session not found");
  const expiring = await login();
  vi.setSystemTime(Date.now() + 3_601_000);
  await expect(auth.require(request(expiring))).rejects.toThrow("Session expired");
});

test("disable, password change, server reset and incident revocation invalidate every session and in-flight login", async () => {
  const { local, auth, db, login, request } = setup();
  const created = await local.create("Alice", "Alice", PASSWORD);
  if (!created.ok) throw new Error(created.error);
  const first = await login();
  const second = await login();
  expect(
    (
      await local.replacePassword("Alice", NEW_PASSWORD, {
        userId: created.value,
        password: "wrong current password",
      })
    ).ok,
  ).toBe(false);
  expect((await auth.require(request(first))).kind).toBe("local_admin");
  expect(
    (
      await local.replacePassword("Alice", NEW_PASSWORD, {
        userId: created.value,
        password: PASSWORD,
      })
    ).ok,
  ).toBe(true);
  for (const cookie of [first, second])
    await expect(auth.require(request(cookie))).rejects.toThrow();
  expect((await local.authenticate("Alice", PASSWORD)).ok).toBe(false);
  const pending = await local.authenticate("Alice", NEW_PASSWORD);
  if (!pending.ok) throw new Error(pending.error);
  local.setEnabled("Alice", false);
  expect(
    await auth.createLocalSession(pending.value.userId, pending.value.revision),
  ).toBeUndefined();
  local.setEnabled("Alice", true);
  expect((await local.replacePassword("Alice", PASSWORD)).ok).toBe(true);
  expect((await local.authenticate("Alice", NEW_PASSWORD)).ok).toBe(false);
  const active = await login();
  local.revokeByUsername("Alice");
  await expect(auth.require(request(active))).rejects.toThrow();
  expect(
    db
      .select()
      .from(localAuthEvents)
      .all()
      .map((e) => e.kind),
  ).toEqual(
    expect.arrayContaining([
      "created",
      "password_changed",
      "password_reset",
      "disabled",
      "enabled",
      "sessions_revoked",
      "login_succeeded",
      "login_refused",
    ]),
  );
});

test("turning local auth off blocks retained sessions while OIDC and API key sessions still work", async () => {
  const { local, auth, db, request } = setup(false);
  const created = await local.create("Alice", "Alice", PASSWORD);
  if (!created.ok) throw new Error(created.error);
  expect(await auth.createLocalSession(created.value, 1)).toBeUndefined();
  db.insert(authSessions)
    .values({
      id: "stale-local",
      kind: "local_admin",
      user_id: created.value,
      expires_at: new Date(Date.now() + 60000),
    })
    .run();
  const external = await auth.findOrCreateUser("oidc:alice", { name: "Alice SSO" });
  const oidc = await auth.createOidcSession(external, { name: "Alice SSO" });
  expect((await auth.require(request(oidc))).kind).toBe("oidc");
  expect(
    (await auth.require(request(await auth.createApiKeySession("test-api-key", "Key", 60000))))
      .kind,
  ).toBe("api_key");
  await expect(
    auth.findOrCreateUser(`local:${created.value}`, { name: "Impersonator" }),
  ).rejects.toMatchObject({ init: { status: 403 } });
  const confused = await auth.createOidcSession(created.value, { name: "Impersonator" });
  await expect(auth.require(request(confused))).rejects.toThrow("Invalid session identity");
});

test("maintenance commands use hidden password prompts and refuse confirmation mismatches", async () => {
  const { local } = setup();
  const prompt = { text: async () => "Alice", secret: async () => PASSWORD };
  expect(await adminCommand(local, ["create", "Alice"], prompt)).toBe("Administrator created.");
  expect(await adminCommand(local, ["list"], prompt)).not.toContain("password");
  let next = false;
  await expect(
    adminCommand(local, ["reset-password", "Alice"], {
      ...prompt,
      secret: async () => {
        next = !next;
        return next ? PASSWORD : NEW_PASSWORD;
      },
    }),
  ).rejects.toThrow("Passwords do not match.");
  expect(await adminCommand(local, ["disable", "Alice"], prompt)).toContain("All sessions revoked");
  expect(await adminCommand(local, ["enable", "Alice"], prompt)).toContain("All sessions revoked");
  expect(
    await adminCommand(local, ["reset-password", "Alice"], {
      ...prompt,
      secret: async () => NEW_PASSWORD,
    }),
  ).toContain("Password reset");
  expect((await local.authenticate("Alice", NEW_PASSWORD)).ok).toBe(true);
});

test("sensitive actions reject foreign origins, opaque origins and cross-site fetch metadata", () => {
  for (const headers of Array<Record<string, string>>(
    { origin: "https://evil.test" },
    { origin: "null" },
    { "Sec-Fetch-Site": "cross-site" },
  )) {
    expect(() =>
      requireSameOrigin(
        new Request("https://headplane.test/admin/login", { method: "POST", headers }),
      ),
    ).toThrow("Invalid request origin");
  }
  expect(() =>
    requireSameOrigin(
      new Request("https://headplane.test/admin/login", {
        method: "POST",
        headers: { origin: "https://headplane.test" },
      }),
    ),
  ).not.toThrow();
});
