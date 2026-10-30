import { expect, test } from "vitest";

import { guestVersion, safeReleasePath, scanContents } from "../../../scripts/guest-release";

test("the Guest version matches its base and rejects feature counters or shell input", () => {
  expect(guestVersion("v0.8.1-guest", "0.8.1-guest")).toBe("0.8.1-guest");
  expect(guestVersion("v0.8.2-guest", "0.8.2-guest")).toBe("0.8.2-guest");
  for (const tag of [
    "v0.8.1-guest.1",
    "v0.8.1-guest; echo secret",
    "v0.8.1",
    "refs/heads/main",
    "v0.8.2-guest",
  ])
    expect(() => guestVersion(tag, "0.8.1-guest")).toThrow();
});
test("archive allowlisting refuses data files, secrets, sourcemaps and traversal", () => {
  for (const path of [
    "node_modules/private/index.js",
    "C:\\secret",
    "../config.yaml",
    "/etc/headplane/config.yaml",
    "build/client/a.js.map",
    "data/hp_persist.db",
    ".env",
    "nested/.env.production",
    "guest-mail/message.eml",
    "server.key",
    "DEV_SETUP.md",
  ])
    expect(() => safeReleasePath(path)).toThrow();
  expect(() =>
    safeReleasePath("drizzle/20261029220612_guest_access_duration/migration.sql"),
  ).not.toThrow();
  expect(() => safeReleasePath("config.example.yaml")).not.toThrow();
});
test("artifact scanning catches SQLite headers, real PEM blocks, tokens and local deployment paths", () => {
  for (const contents of [
    "SQLite format 3\0contents",
    "-----BEGIN PRIVATE KEY-----\n" + "a".repeat(80) + "\n-----END PRIVATE KEY-----",
    "ghp_" + "a".repeat(40),
    "/home/brokcat/private/config",
    "B550-GAMING-X-V2",
  ])
    expect(() => scanContents(Buffer.from(contents), "build/server/index.js")).toThrow();
  expect(() => scanContents(Buffer.from("//# sourceMappingURL=x"), "build/client/x.js")).toThrow();
  expect(() =>
    scanContents(Buffer.from("-----BEGIN PRIVATE KEY-----"), "build/server/index.js"),
  ).not.toThrow();
});
