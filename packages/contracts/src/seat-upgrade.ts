/** The catalog fields the choice reads; a catalog entry plus its self-service flag. */
export type SeatUpgradeCandidate = {
  key: string;
  label: string;
  monthlyPriceMicros: number | null;
  seatLimit: number | null;
  selfService: boolean;
};

/**
 * The one plan that fixes a seat-limit refusal: the cheapest self-service plan
 * above the current one with room for `seatsNeeded` people, else Enterprise
 * (assigned by us, not bought). Null when nothing in the catalog adds the seats.
 * A current plan whose price is unknown (not in the catalog, or custom-priced)
 * is never "upgraded" to a self-service plan that might cost less.
 */
export function seatUpgradePlan<T extends SeatUpgradeCandidate>(
  plans: readonly T[],
  currentKey: string | null | undefined,
  seatsNeeded: number,
): T | null {
  if (currentKey === "enterprise") return null;
  const current = currentKey ? plans.find((plan) => plan.key === currentKey) : undefined;
  const currentPrice = currentKey ? (current?.monthlyPriceMicros ?? null) : 0;
  const fits = (plan: T) => plan.seatLimit === null || plan.seatLimit >= seatsNeeded;
  const paid =
    currentPrice === null
      ? []
      : plans
          .filter(
            (plan) =>
              plan.selfService &&
              plan.key !== currentKey &&
              (plan.monthlyPriceMicros ?? 0) > currentPrice &&
              fits(plan),
          )
          .sort((a, b) => (a.monthlyPriceMicros ?? 0) - (b.monthlyPriceMicros ?? 0));
  return paid[0] ?? plans.find((plan) => plan.key === "enterprise" && fits(plan)) ?? null;
}
