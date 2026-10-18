// Decimal wire tokens have a disjoint namespace from the old signed-bigint
// workspace counter. The payload remains an unsigned, exact PostgreSQL xid8.
export const SESSION_ACTIVITY_TOKEN_BASE = 1n << 64n;
export const SESSION_ACTIVITY_TOKEN_MAX = (1n << 65n) - 1n;

export function normalizeActivityToken(value: string, label: string): string {
  if (!/^(?:0|[1-9]\d*)$/.test(value)) {
    throw new Error(`sessions_list ${label} must be a decimal activity revision`);
  }
  if (BigInt(value) > SESSION_ACTIVITY_TOKEN_MAX) {
    throw new Error(`sessions_list ${label} exceeds the database activity revision range`);
  }
  return value;
}

export function encodeActivityXid(xid: string): string {
  return (SESSION_ACTIVITY_TOKEN_BASE + BigInt(xid)).toString();
}

/**
 * Old replicas cannot observe new writers through their legacy counter during
 * a mixed rollout. Every legacy token restarts on a new replica, healing those
 * temporary misses with a superset. Never interpret a counter value as an xid.
 */
export function decodeActivityXid(token: string): string {
  const value = BigInt(normalizeActivityToken(token, "activity token"));
  return value < SESSION_ACTIVITY_TOKEN_BASE
    ? "0"
    : (value - SESSION_ACTIVITY_TOKEN_BASE).toString();
}

export function isActivityXidToken(token: string): boolean {
  return BigInt(normalizeActivityToken(token, "activity token")) >= SESSION_ACTIVITY_TOKEN_BASE;
}
