/** Shared browser/server interpretation of access intentions. No network side effects. */
export interface AccessPlan {
  requested_duration_seconds: number | null;
  requested_expires_at: Date | null;
}

export const MAX_ACCESS_DATE_MS = 366 * 5 * 86400_000;

function calendar(value: string) {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const date = new Date(`${value}Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 16) === value ? date : null;
}

export function localDateTime(instant: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(instant);
  const part = (key: string) => parts.find((p) => p.type === key)!.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}

/** Reject gaps and folds rather than silently picking an offset at a DST change. */
export function localAccessDate(
  value: string,
  timeZone: string,
): { date: Date } | { error: string } {
  const wall = calendar(value);
  if (!wall) return { error: "Enter a real date and time." };
  try {
    const offsets = new Set<number>();
    // All modern IANA offsets and both sides of local clock changes fall in
    // this window, including half-hour DST and international date-line jumps.
    for (let hour = -36; hour <= 36; hour += 3) {
      const probe = new Date(wall.getTime() + hour * 3600_000);
      offsets.add(calendar(localDateTime(probe, timeZone))!.getTime() - probe.getTime());
    }
    const matches = [...offsets]
      .map((offset) => new Date(wall.getTime() - offset))
      .filter((date) => localDateTime(date, timeZone) === value);
    if (matches.length === 0)
      return {
        error: "This local time does not exist because the clock changes. Choose another time.",
      };
    if (matches.length !== 1)
      return {
        error: "This local time is ambiguous because the clock changes. Choose another time.",
      };
    return { date: matches[0] };
  } catch {
    return { error: "Choose a valid IANA time zone." };
  }
}

export function validateAccessDate(value: string, zone: string, now = Date.now()) {
  const result = localAccessDate(value, zone);
  if ("error" in result) return result;
  if (result.date.getTime() <= now) return { error: "Choose an access expiry in the future." };
  if (result.date.getTime() > now + MAX_ACCESS_DATE_MS)
    return { error: "Choose an access expiry within five years." };
  return result;
}

export function accessKind(plan: AccessPlan) {
  // Older requests could contain both intentions. Retain their data and use
  // the absolute deadline as the stricter interpretation until explicitly edited.
  return plan.requested_expires_at ? "absolute" : "relative";
}

export function accessDurationLabel(plan: AccessPlan) {
  if (accessKind(plan) === "absolute") return "Custom date";
  return (
    (
      {
        43200: "12 hours",
        86400: "24 hours (legacy)",
        172800: "48 hours",
        604800: "7 days",
      } as Record<number, string>
    )[plan.requested_duration_seconds ?? 0] ?? "Unspecified"
  );
}

/** Future provisioning must call this again at activation, never at issuance. */
export function accessExpiryAtActivation(plan: AccessPlan, activatedAt: Date): Date | null {
  if (!Number.isFinite(activatedAt.getTime())) return null;
  if (plan.requested_expires_at)
    return plan.requested_expires_at > activatedAt ? plan.requested_expires_at : null;
  const seconds = plan.requested_duration_seconds;
  return seconds && [43200, 86400, 172800, 604800].includes(seconds)
    ? new Date(activatedAt.getTime() + seconds * 1000)
    : null;
}
