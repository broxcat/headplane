import type { DatabaseSync } from "node:sqlite";

import type { NodeSQLiteDatabase } from "drizzle-orm/node-sqlite";
import { migrate as drizzleMigrate } from "drizzle-orm/node-sqlite/migrator";

/** SQLite table rebuilds require FK mode to change before Drizzle's BEGIN.
 * The versioned rebuild checks all FK references before the transaction commits.
 * Restore connection enforcement even when a migration rolls back.
 */
export function migrate(
  db: NodeSQLiteDatabase & { $client: DatabaseSync },
  config: Parameters<typeof drizzleMigrate>[1],
) {
  const foreignKeys = db.$client.prepare("PRAGMA foreign_keys").get()?.foreign_keys;
  db.$client.exec("PRAGMA foreign_keys = OFF");
  try {
    drizzleMigrate(db, config);
  } finally {
    db.$client.exec(`PRAGMA foreign_keys = ${foreignKeys ? "ON" : "OFF"}`);
  }
}
