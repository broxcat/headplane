import { cp, readdir } from "node:fs/promises";
import { join } from "node:path";

import { drizzle } from "drizzle-orm/node-sqlite";
import { expect, test } from "vitest";

import { migrate } from "~/server/db/migrate";
import { createGuestResourceService } from "~/server/guest-resources";
import { createGuestService } from "~/server/guests";

import { tempDir } from "../../support/temp";

test("the additive resource migration preserves the 11-migration database and resource intentions survive reopening", async () => {
  const dir = await tempDir();
  const prior = join(dir, "prior");
  for (const folder of (await readdir("drizzle")).filter((f) => f < "20261030124826"))
    await cp(join("drizzle", folder), join(prior, folder), { recursive: true });
  const path = join(dir, "copy.db");
  const db = drizzle(path);
  migrate(db, { migrationsFolder: prior });
  const created = createGuestService(db).create(
    { email: "retained@example.com", duration: "43200" },
    null,
  );
  if (!created.ok) throw new Error(created.error.message);
  const existing = db.$client.prepare("SELECT * FROM guests").all();
  migrate(db, { migrationsFolder: "drizzle" });
  expect(db.$client.prepare("SELECT * FROM guests").all()).toEqual(existing);
  expect(db.$client.prepare("SELECT count(*) AS n FROM __drizzle_migrations").get()?.n).toBe(
    (await readdir("drizzle")).length,
  );
  const node = {
    id: "1",
    name: "machine",
    addresses: ["100.64.0.1"],
    owner: null,
    tags: [],
    online: true,
    announced: [],
    approved: [],
  };
  createGuestResourceService(db).save(
    created.value.id,
    1,
    JSON.stringify([
      {
        kind: "node",
        node_id: "1",
        address: "100.64.0.1",
        route: null,
        protocol: "tcp",
        ports: "3000",
      },
    ]),
    [node],
  );
  db.$client.close();
  const reopened = drizzle(path);
  try {
    migrate(reopened, { migrationsFolder: "drizzle" });
    expect(createGuestResourceService(reopened).list(created.value.id)).toMatchObject({
      value: [{ ports: "3000" }],
    });
    expect(reopened.$client.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally {
    reopened.$client.close();
  }
});
