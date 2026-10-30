import { expect, test } from "vitest";

import {
  accessExpiryAtActivation,
  localAccessDate,
  localDateTime,
  validateAccessDate,
} from "~/utils/guest-access";

// Regression: treating a local wall clock as UTC or using the server's zone
// stores the wrong deadline; implicit DST disambiguation silently grants extra time.
test.for([
  ["Europe/Paris", "2030-07-01T12:30", "2030-07-01T10:30:00.000Z"],
  ["America/New_York", "2030-07-01T12:30", "2030-07-01T16:30:00.000Z"],
  ["Asia/Kathmandu", "2030-07-01T12:30", "2030-07-01T06:45:00.000Z"],
  ["Australia/Lord_Howe", "2030-01-01T12:30", "2030-01-01T01:30:00.000Z"],
])("local date conversion round-trips in %s", ([zone, wall, utc]) => {
  const result = localAccessDate(wall, zone);
  expect(result).toEqual({ date: new Date(utc) });
  expect(localDateTime(new Date(utc), zone)).toBe(wall);
});

test.for([
  ["Europe/Paris", "2030-03-31T02:30"], // gap
  ["Europe/Paris", "2030-10-27T02:30"], // fold
  ["America/New_York", "2030-11-03T01:30"],
  ["Australia/Lord_Howe", "2030-04-07T01:45"], // half-hour fold
  ["UTC", "2030-02-30T12:00"],
  ["UTC", "2030-01-01T24:00"],
  ["not/a-zone", "2030-01-01T12:00"],
])("invalid or non-unique local time %j is refused", ([zone, wall]) => {
  expect(localAccessDate(wall, zone)).toHaveProperty("error");
});

test("expiry limits use the actual instant and browser timezone changes preserve the instant", () => {
  const now = Date.parse("2030-01-01T00:00Z");
  expect(validateAccessDate("2030-01-01T00:00", "UTC", now)).toHaveProperty("error");
  expect(validateAccessDate("2040-01-01T00:00", "UTC", now)).toHaveProperty("error");
  const instant = new Date("2030-07-01T10:30Z");
  for (const zone of ["Europe/Paris", "America/New_York", "Asia/Tokyo"])
    expect(localAccessDate(localDateTime(instant, zone), zone)).toEqual({ date: instant });
});

test("future activation computes relative expiry then and refuses elapsed absolute deadlines", () => {
  const activation = new Date("2030-08-01T12:00Z");
  for (const seconds of [43200, 172800, 604800])
    expect(
      accessExpiryAtActivation(
        { requested_duration_seconds: seconds, requested_expires_at: null },
        activation,
      )?.getTime(),
    ).toBe(activation.getTime() + seconds * 1000);
  expect(
    accessExpiryAtActivation(
      { requested_duration_seconds: null, requested_expires_at: new Date("2030-08-01T11:59Z") },
      activation,
    ),
  ).toBeNull();
  // Historical mixed records retain their absolute upper bound.
  expect(
    accessExpiryAtActivation(
      { requested_duration_seconds: 86400, requested_expires_at: new Date("2030-08-01T13:00Z") },
      activation,
    ),
  ).toEqual(new Date("2030-08-01T13:00Z"));
});
