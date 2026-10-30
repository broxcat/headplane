import { describe, expect, test } from "vitest";

import { guestBuildCompatibility, parseBuildInfo } from "~/server/headscale/api/build-info";
import { formatServerVersion, parseServerVersion } from "~/server/headscale/api/server-version";

const custom = {
  version: "v0.29.6+dirty",
  commit: "a2b1d7863926834e94479dcdd91ab344a9356bd0",
  buildTime: "2026-10-24T09:21:24Z",
  go: { version: "go1.27.3", os: "linux", arch: "amd64" },
  dirty: true,
};
const build = parseBuildInfo(custom);
const approval = { version: "0.29.6", commit: custom.commit, fingerprint: build.fingerprint! };

test("logs preserve build metadata instead of displaying a dirty binary as a release", () => {
  expect(formatServerVersion(parseServerVersion(custom.version))).toBe("0.29.6+dirty");
});

test("only an exact explicit approval admits a modified build", () => {
  expect(guestBuildCompatibility(build)).toBe("unapproved_build");
  expect(guestBuildCompatibility(build, [approval])).toBe("approved_build");
  for (const field of ["version", "commit", "fingerprint"] as const)
    expect(guestBuildCompatibility(build, [{ ...approval, [field]: "different" }])).toBe(
      "unapproved_build",
    );
});

describe("a build approval cannot survive changed or missing metadata", () => {
  test.each([
    { ...custom, commit: "0".repeat(40) },
    { ...custom, buildTime: "2026-10-25T09:21:24Z" },
    { ...custom, go: { ...custom.go, version: "go1.27.4" } },
    { ...custom, go: { ...custom.go, arch: "arm64" } },
    { ...custom, dirty: false },
    { ...custom, commit: undefined },
    { ...custom, dirty: "true" },
    { ...custom, go: undefined },
  ])("blocks a different server build %#", (reported) => {
    expect(guestBuildCompatibility(parseBuildInfo(reported), [approval])).toBe("unapproved_build");
  });
});

test("a dirty flag cannot masquerade as an official release without the suffix", () => {
  expect(guestBuildCompatibility(parseBuildInfo({ ...custom, version: "v0.29.6" }))).toBe(
    "unapproved_build",
  );
});

test.each(["dev", "v0.0.0-20260703052708-048308511c72", "0.29.6-beta.1"])(
  "unidentified or prerelease %s remains blocked even with an approval",
  (version) => {
    const candidate = parseBuildInfo({ ...custom, version });
    expect(
      guestBuildCompatibility(candidate, [{ ...approval, fingerprint: candidate.fingerprint! }]),
    ).toBe("unknown_build");
  },
);

test.each(["0.27.1", "0.28.0", "0.30.0", "1.0.0"])(
  "approval cannot expand the tested Guest VPN version range to %s",
  (version) => {
    const candidate = parseBuildInfo({ ...custom, version });
    expect(
      guestBuildCompatibility(candidate, [
        { version, commit: custom.commit, fingerprint: candidate.fingerprint! },
      ]),
    ).toBe("unsupported_version");
  },
);

test("an official stable release remains usable without a custom approval", () => {
  expect(guestBuildCompatibility(parseBuildInfo({ version: "v0.29.5", dirty: false }))).toBe(
    "supported_release",
  );
});
