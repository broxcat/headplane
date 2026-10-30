import { drizzle } from "drizzle-orm/node-sqlite";
import { migrate } from "drizzle-orm/node-sqlite/migrator";

import { createAuthService } from "~/server/web/auth";

export function createTestAuth(
  options: {
    headscaleApiKey?: string;
    localEnabled?: boolean;
    cookie?: { secure?: boolean; maxAge?: number };
    proxyAuth?: {
      enabled: boolean;
      allowedCidrs?: string[];
      trustedProxyCidrs?: string[];
      ipHeader?: string;
      userHeader?: string;
      emailHeader?: string;
      nameHeader?: string;
      pictureHeader?: string;
    };
  } = {},
) {
  const db = drizzle(":memory:");
  migrate(db, { migrationsFolder: "./drizzle" });

  const auth = createAuthService({
    secret: "test-secret-key-for-unit-tests",
    localEnabled: options.localEnabled,
    headscaleApiKey: options.headscaleApiKey,
    proxyAuth: options.proxyAuth,
    db,
    cookie: {
      name: "_hp_test",
      path: "/admin",
      secure: false,
      maxAge: 3600,
      ...options.cookie,
    },
  });

  return { auth, db };
}
