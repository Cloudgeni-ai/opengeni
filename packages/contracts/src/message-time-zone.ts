/**
 * The IANA time zone a person's client reports when they send a message, so
 * the model can see the message's local time. Dependency-free so browser
 * packages can import it without the schema bundle.
 */

/** Longest accepted time zone name. Real IANA names are at most about 32 characters. */
export const MESSAGE_TIME_ZONE_MAX_CHARS = 64;

/**
 * Turn metadata key for the sender's IANA time zone, frozen when the message is
 * accepted. Claim renders the message's local time from it exactly once.
 */
export const MESSAGE_TIME_ZONE_METADATA_KEY = "messageTimeZone" as const;

/**
 * IANA names such as `Europe/Oslo`, `America/Argentina/Buenos_Aires`,
 * `Etc/GMT+5` or `EST5EDT`. Numeric offsets (`+01:00`) are not zone names.
 */
export const MESSAGE_TIME_ZONE_PATTERN = /^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+){0,2}$/;

// Zones that are plain UTC add nothing to the UTC time already shown.
const UTC_EQUIVALENT_TIME_ZONE = /^(?:Etc\/)?(?:UTC|UCT|Universal|Zulu|Greenwich|GMT(?:[+-]?0)?)$/i;

const formats = new Map<string, Intl.DateTimeFormat>();

function wallClockFormat(timeZone: string): Intl.DateTimeFormat | undefined {
  const cached = formats.get(timeZone);
  if (cached) return cached;
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  } catch {
    return undefined;
  }
  if (formats.size >= 512) formats.clear();
  formats.set(timeZone, format);
  return format;
}

function namesRealZone(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MESSAGE_TIME_ZONE_MAX_CHARS &&
    MESSAGE_TIME_ZONE_PATTERN.test(value) &&
    !UTC_EQUIVALENT_TIME_ZONE.test(value)
  );
}

/**
 * The canonical name of a sender's time zone, or undefined when the value is
 * not an IANA zone name this runtime can resolve, or is just UTC. Accepting
 * surfaces store the returned name; clients use it to drop invalid values.
 */
export function normalizeMessageTimeZone(value: unknown): string | undefined {
  if (typeof value !== "string" || !namesRealZone(value)) return undefined;
  const resolved = wallClockFormat(value)?.resolvedOptions().timeZone;
  return resolved && namesRealZone(resolved) ? resolved : undefined;
}

/** The sender's time zone frozen in one accepted turn's metadata, when it holds a usable one. */
export function messageTimeZoneFromTurnMetadata(metadata: unknown): string | undefined {
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)[MESSAGE_TIME_ZONE_METADATA_KEY];
  return normalizeMessageTimeZone(value) !== undefined ? (value as string) : undefined;
}

/** The time zone this runtime's own clock uses, when it is a usable IANA zone. */
export function currentMessageTimeZone(): string | undefined {
  try {
    return normalizeMessageTimeZone(new Intl.DateTimeFormat().resolvedOptions().timeZone);
  } catch {
    return undefined;
  }
}

/**
 * Calendar date and minute of `date` on a wall clock in `timeZone` (seconds
 * are truncated, as in UTC rendering). Undefined for an unusable zone.
 */
export function messageTimeZoneWallClock(
  date: Date,
  timeZone: string,
): { year: number; month: number; day: number; hour: number; minute: number } | undefined {
  if (normalizeMessageTimeZone(timeZone) === undefined) return undefined;
  const format = wallClockFormat(timeZone);
  if (!format) return undefined;
  const parts: Partial<Record<Intl.DateTimeFormatPartTypes, string>> = {};
  for (const part of format.formatToParts(date)) parts[part.type] = part.value;
  const clock = {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    // Some engines spell midnight as 24 even with a 23-hour cycle.
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
  };
  return Object.values(clock).every(Number.isInteger) ? clock : undefined;
}
