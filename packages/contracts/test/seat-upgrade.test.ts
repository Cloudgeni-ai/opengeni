import { expect, test } from "bun:test";
import { seatUpgradePlan } from "../src/seat-upgrade";

// Bendik's limits: Free 1, Pro ($20) 2, Max ($100) 10, Enterprise unlimited.
const plans = [
  { key: "free", label: "Free", monthlyPriceMicros: 0, seatLimit: 1, selfService: false },
  { key: "pro", label: "Pro", monthlyPriceMicros: 20_000_000, seatLimit: 2, selfService: true },
  { key: "max", label: "Max", monthlyPriceMicros: 100_000_000, seatLimit: 10, selfService: true },
  {
    key: "enterprise",
    label: "Enterprise",
    monthlyPriceMicros: null,
    seatLimit: null,
    selfService: false,
  },
];
const pick = (current: string | null, seatsNeeded: number, catalog = plans) =>
  seatUpgradePlan(catalog, current, seatsNeeded)?.key ?? null;

test("the fix is the cheapest self-service plan above the current one with room", () => {
  expect(pick("free", 2)).toBe("pro");
  expect(pick("free", 3)).toBe("max");
  expect(pick("pro", 3)).toBe("max");
  expect(pick("max", 11)).toBe("enterprise");
  // Without the plan key (an older trigger), the seats needed still decide.
  expect(pick(null, 2)).toBe("pro");
  expect(pick(null, 11)).toBe("enterprise");
});

test("nothing above Enterprise, and no plan when nothing in the catalog adds the seats", () => {
  expect(pick("enterprise", 50)).toBeNull();
  expect(pick("max", 11, plans.slice(0, 3))).toBeNull();
  // A plan that is not self-service is never offered as a purchase.
  expect(
    pick(
      "free",
      2,
      plans.map((plan) => ({ ...plan, selfService: false })),
    ),
  ).toBe("enterprise");
});
