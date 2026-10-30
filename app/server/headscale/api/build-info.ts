import { createHash } from "node:crypto";

import { formatServerVersion, parseServerVersion } from "./server-version";

export interface ApprovedBuild {
  version: string;
  commit: string;
  fingerprint: string;
}

/** Observed metadata, not a remote attestation of the binary's integrity. */
export function parseBuildInfo(input: unknown) {
  const raw = input && typeof input === "object" ? (input as Record<string, unknown>) : {};
  const version = parseServerVersion(typeof raw.version === "string" ? raw.version : "unknown");
  const go = raw.go && typeof raw.go === "object" ? (raw.go as Record<string, unknown>) : {};
  const commit =
    typeof raw.commit === "string" && /^[0-9a-f]{40}$/.test(raw.commit) ? raw.commit : null;
  const complete =
    commit &&
    typeof raw.dirty === "boolean" &&
    typeof raw.buildTime === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(raw.buildTime) &&
    Number.isFinite(Date.parse(raw.buildTime)) &&
    [go.version, go.os, go.arch].every((v) => typeof v === "string" && /^[\w.+-]{1,80}$/.test(v));
  const fingerprint = complete
    ? createHash("sha256")
        .update(
          JSON.stringify([
            "headscale-build-v1",
            formatServerVersion(version),
            commit,
            raw.buildTime,
            raw.dirty,
            go.version,
            go.os,
            go.arch,
          ]),
        )
        .digest("hex")
    : null;
  return {
    version,
    commit,
    fingerprint,
    // Malformed flags must not turn custom builds into official releases.
    modified:
      Boolean(version.build) ||
      raw.dirty === true ||
      (raw.dirty !== undefined && typeof raw.dirty !== "boolean"),
  };
}

export type BuildInfo = ReturnType<typeof parseBuildInfo>;
export type GuestBuildCompatibility =
  | "supported_release"
  | "approved_build"
  | "unapproved_build"
  | "unknown_build"
  | "unsupported_version";

export function guestBuildCompatibility(
  build: BuildInfo,
  approvals: readonly ApprovedBuild[] = [],
): GuestBuildCompatibility {
  const v = build.version;
  if (v.unknown || v.prerelease) return "unknown_build";
  if (v.major !== 0 || v.minor !== 29) return "unsupported_version";
  if (!build.modified) return "supported_release";
  const core = `${v.major}.${v.minor}.${v.patch}`;
  return build.fingerprint &&
    approvals.some(
      (a) => a.version === core && a.commit === build.commit && a.fingerprint === build.fingerprint,
    )
    ? "approved_build"
    : "unapproved_build";
}
