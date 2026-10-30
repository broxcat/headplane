import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";
import { expect, test, vi } from "vitest";

import { migrate } from "~/server/db/migrate";
import { guestInvitations, guestVpnAccess } from "~/server/db/schema";
import { createGuestPolicyWriter } from "~/server/guest-policy-writer";
import { createGuestService } from "~/server/guests";
import { createLocalAuthService } from "~/server/web/local-auth";

import { tempDir } from "../../support/temp";

test("VPN migration upgrades the deployed local-auth schema without losing guests or invitations", async () => {
  const dir = await tempDir();
  const prior = join(dir, "prior");
  for (const folder of (await readdir("drizzle")).filter((f) => !f.endsWith("_guest_vpn_access")))
    await cp(join("drizzle", folder), join(prior, folder), { recursive: true });
  const path = join(dir, "copy.db");
  const db = drizzle(path);
  try {
    migrate(db, { migrationsFolder: prior });
    const result = createGuestService(db).create(
      { email: "retained-vpn@example.test", duration: "43200" },
      null,
    );
    if (!result.ok) throw new Error(result.error.message);
    db.insert(guestInvitations)
      .values({
        id: "retained-invitation",
        guest_id: result.value.id,
        email: result.value.email,
        status: "accepted",
        accepted_at: new Date(),
        created_at: new Date(),
      })
      .run();
    const local = createLocalAuthService(db, "vpn-upgrade-test");
    expect(
      (await local.create("retained-admin", "Retained", "retained migration test passphrase")).ok,
    ).toBe(true);
    const credentials = db.$client.prepare("SELECT * FROM local_admin_users").all();
    const migrations = db.$client.prepare("SELECT * FROM __drizzle_migrations").all();
    const guest = db.$client.prepare("SELECT * FROM guests").all();
    const invitation = db.$client.prepare("SELECT * FROM guest_invitations").all();
    migrate(db, { migrationsFolder: "drizzle" });
    expect(db.$client.prepare("SELECT * FROM local_admin_users").all()).toEqual(credentials);
    expect(
      db.$client.prepare("SELECT * FROM __drizzle_migrations").all().slice(0, migrations.length),
    ).toEqual(migrations);
    expect(
      (await local.authenticate("retained-admin", "retained migration test passphrase")).ok,
    ).toBe(true);
    expect(db.$client.prepare("SELECT * FROM guests").all()).toEqual(guest);
    expect(db.$client.prepare("SELECT * FROM guest_invitations").all()).toEqual(invitation);
    expect(db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()?.n).toBe(14);
    expect(db.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(() =>
      db
        .insert(guestVpnAccess)
        .values({
          guest_id: result.value.id,
          user_name: "dedicated",
          user_marker: "marker",
          state: "active",
          created_at: new Date(),
          updated_at: new Date(),
        })
        .run(),
    ).toThrow();
  } finally {
    db.$client.close();
  }
});

test("policy writers share a durable lease and an old owner cannot release a successor's lock", async () => {
  const db = drizzle(":memory:");
  migrate(db, { migrationsFolder: "drizzle" });
  const first = createGuestPolicyWriter(db),
    second = createGuestPolicyWriter(db);
  try {
    await first.locked(async () => {
      await expect(second.locked(async () => undefined)).rejects.toThrow(
        "Another policy or guest operation",
      );
    });
    await expect(second.locked(async () => "released")).resolves.toBe("released");
    vi.useFakeTimers();
    await first.locked(async ({ check }) => {
      vi.advanceTimersByTime(121_000);
      await second.locked(async () => expect(check).toThrow("lease was lost"));
    });
  } finally {
    vi.useRealTimers();
    db.$client.close();
  }
});
