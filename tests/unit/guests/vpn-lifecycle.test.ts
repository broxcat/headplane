import { describe, expect, test } from "vitest";

import {
  accessDeadline,
  canTransition,
  retryDeadline,
  deviceHasExpired,
} from "~/server/guest-vpn-lifecycle";

test("a Go zero-time means unlimited device lifetime and cannot confirm revocation", () => {
  const now = Date.parse("2027-01-01T00:00:00Z");
  for (const value of [
    null,
    undefined,
    "0001-01-01T00:00:00Z",
    "0001-01-01T00:00:00.000Z",
    "0001-01-01 00:00:00",
    "invalid",
  ])
    expect(deviceHasExpired(value, now), String(value)).toBe(false);
  expect(deviceHasExpired("2026-12-31T23:59:59Z", now)).toBe(true);
  expect(deviceHasExpired("2027-01-01T00:00:01Z", now)).toBe(false);
});

describe("network deadlines start at confirmed activation, never at draft or invitation creation", () => {
  test.each([
    [43200, "2027-01-10T12:00:00.000Z"],
    [172800, "2027-01-12T00:00:00.000Z"],
    [604800, "2027-01-17T00:00:00.000Z"],
  ])("a delayed activation still receives its full %s-second duration", (duration, expected) => {
    expect(
      accessDeadline(
        { requested_duration_seconds: Number(duration), requested_expires_at: null },
        new Date("2027-01-10T00:00:00Z"),
      ).toISOString(),
    ).toBe(expected);
  });
  test("an absolute deadline, including a mixed legacy record, never moves with activation", () => {
    const deadline = new Date("2027-03-28T01:30:00Z");
    expect(
      accessDeadline(
        { requested_duration_seconds: 604800, requested_expires_at: deadline },
        new Date("2027-03-28T01:00:00Z"),
      ),
    ).toEqual(deadline);
    expect(() =>
      accessDeadline(
        { requested_duration_seconds: 604800, requested_expires_at: deadline },
        new Date("2027-03-28T01:30:00Z"),
      ),
    ).toThrow("already passed");
  });
});

test("revocation cannot announce active or restart a terminal network access", () => {
  expect(canTransition("revoking", "active")).toBe(false);
  expect(canTransition("revoked", "provisioning")).toBe(false);
  expect(canTransition("expired", "active")).toBe(false);
  expect(canTransition("active", "revoking")).toBe(true);
  expect(canTransition("revoking", "revoked")).toBe(true);
  expect(canTransition("error", "revoked")).toBe(false);
});

test("retry backoff is based on persisted attempts and remains bounded after restarts", () => {
  const now = Date.parse("2027-01-01T00:00:00Z");
  expect(retryDeadline(2, now).getTime() - now).toBeGreaterThan(
    retryDeadline(1, now).getTime() - now,
  );
  expect(retryDeadline(10000, now).getTime() - now).toBeLessThanOrEqual(300_000);
});
