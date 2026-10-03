import { describe, expect, test } from "bun:test";
import { SESSION_STATUS_META } from "../src/components/session-status";
import { SESSION_STATUS_BADGE } from "../src/session-status-model";

function alphaSuffix(alpha: number): string {
  return alpha === 1 ? "" : `/${Math.round(alpha * 100)}`;
}

describe("session status badge tokens", () => {
  test("the token table mirrors every web badge class", () => {
    for (const [status, badge] of Object.entries(SESSION_STATUS_BADGE)) {
      const meta = SESSION_STATUS_META[status as keyof typeof SESSION_STATUS_META];
      const expected = [
        `text-og-${badge.text}`,
        `border-og-${badge.border}${alphaSuffix(badge.borderAlpha)}`,
        `bg-og-${badge.fill}/10`,
      ].join(" ");
      expect(meta.badgeClassName).toBe(expected);
    }
  });
});