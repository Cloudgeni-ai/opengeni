import type { Session } from "@/types";

export function sameSessionForContext(a: Session | null, b: Session | null): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  const aKeys = Object.keys(a) as Array<keyof Session>;
  const bKeys = Object.keys(b) as Array<keyof Session>;
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  for (const key of aKeys) {
    if (!Object.prototype.hasOwnProperty.call(b, key) || !Object.is(a[key], b[key])) {
      return false;
    }
  }
  return true;
}
