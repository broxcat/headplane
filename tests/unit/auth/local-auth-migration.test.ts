import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";
import { expect, test } from "vitest";

import { migrate } from "~/server/db/migrate";
import {
  authSessions,
  guestInvitations,
  guestInvitationSessions,
  guestResources,
  guests,
  hostInfo,
  users,
} from "~/server/db/schema";
import { createLocalAuthService } from "~/server/web/local-auth";

import { tempDir } from "../../support/temp";

test("local authentication upgrades a populated SQLite database without changing identities, sessions, guests or invitations", async () => {
  const dir = await tempDir();
  const prior = join(dir, "prior");
  const folders = (await readdir("drizzle")).sort();
  const next = folders.find((f) => f.endsWith("_local_admin_auth"))!;
  for (const folder of folders.filter((f) => f < next))
    await cp(join("drizzle", folder), join(prior, folder), { recursive: true });
  const path = join(dir, "upgrade.db");
  const db = drizzle(path);
  migrate(db, { migrationsFolder: prior });
  const now = new Date();
  db.insert(users).values({ id: "owner", sub: "oidc-owner", role: "owner" }).run();
  db.insert(authSessions)
    .values([
      { id: "oidc-session", kind: "oidc", user_id: "owner", expires_at: new Date("2030-01-01") },
      {
        id: "api-session",
        kind: "api_key",
        api_key_hash: "existing-hash",
        expires_at: new Date("2030-01-01"),
      },
    ])
    .run();
  db.insert(hostInfo).values({ host_id: "machine" }).run();
  db.insert(guests)
    .values({
      id: "guest",
      email: "guest@example.test",
      requested_duration_seconds: 43200,
      created_at: now,
      updated_at: now,
    })
    .run();
  db.insert(guestResources)
    .values({
      id: "resource",
      guest_id: "guest",
      kind: "node",
      node_id: "1",
      address: "100.64.0.1",
      protocol: "tcp",
      ports: "443",
      created_at: now,
      updated_at: now,
    })
    .run();
  db.insert(guestInvitations)
    .values({ id: "invitation", guest_id: "guest", email: "guest@example.test", created_at: now })
    .run();
  db.insert(guestInvitationSessions)
    .values({
      id_hash: "retained-challenge",
      invitation_id: "invitation",
      token_version: 0,
      expires_at: new Date("2030-01-01"),
    })
    .run();
  const tables = db.$client
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r) => String(r.name));
  const snapshot = () =>
    Object.fromEntries(
      tables.map((table) => [
        table,
        db.$client.prepare(`SELECT * FROM "${table.replaceAll('"', '""')}" ORDER BY rowid`).all(),
      ]),
    );
  const before = snapshot();
  migrate(db, { migrationsFolder: "drizzle" });
  const after = snapshot();
  // Existing migration history is retained, with one new entry.
  expect(after.__drizzle_migrations.slice(0, before.__drizzle_migrations.length)).toEqual(
    before.__drizzle_migrations,
  );
  for (const table of tables.filter((t) => t !== "__drizzle_migrations"))
    expect(after[table], table).toEqual(before[table]);
  const local = createLocalAuthService(db, "migration-test-secret");
  expect(
    (await local.create("new-admin", "New Administrator", "a migration test passphrase")).ok,
  ).toBe(true);
  db.$client.close();
  const reopened = drizzle(path);
  try {
    migrate(reopened, { migrationsFolder: "drizzle" });
    expect(
      (
        await createLocalAuthService(reopened, "migration-test-secret").authenticate(
          "NEW-ADMIN",
          "a migration test passphrase",
        )
      ).ok,
    ).toBe(true);
    expect(reopened.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(
      reopened
        .select()
        .from(authSessions)
        .all()
        .map((s) => s.id),
    ).toEqual(["oidc-session", "api-session"]);
    expect(reopened.select().from(guestInvitationSessions).get()?.id_hash).toBe(
      "retained-challenge",
    );
  } finally {
    reopened.$client.close();
  }
});
