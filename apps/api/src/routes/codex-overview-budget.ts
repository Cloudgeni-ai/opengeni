export type CodexProviderCall = <T>(operation: () => Promise<T>) => Promise<T>;

type Budget = {
  pending: number;
  permits: number;
  waiters: Array<() => void>;
};

const budgets = new WeakMap<object, Map<string, Budget>>();

/**
 * Organization and workspace overview routes share four provider reads per
 * organization in this API instance. A per-request limiter multiplies the
 * budget when Models prefetches several account details at once.
 *
 * Only scheduling is shared, never credentials, authority or response data.
 * Pending includes queued calls, and holds the budget until the actual read
 * settles even if its HTTP route has already returned a deadline fallback.
 */
export function codexOverviewProviderCall(
  owner: object,
  organizationId: string,
): CodexProviderCall {
  let organizations = budgets.get(owner);
  if (!organizations) {
    organizations = new Map();
    budgets.set(owner, organizations);
  }
  const scopes = organizations;
  return async <T>(operation: () => Promise<T>): Promise<T> => {
    // Look up on every call: an idle budget is removed, while an existing route
    // may still schedule its next account after reading that account's access.
    let budget = scopes.get(organizationId);
    if (!budget) {
      budget = { pending: 0, permits: 4, waiters: [] };
      scopes.set(organizationId, budget);
    }
    budget.pending += 1;
    if (budget.permits > 0) budget.permits -= 1;
    else await new Promise<void>((resolve) => budget.waiters.push(resolve));
    try {
      return await operation();
    } finally {
      const next = budget.waiters.shift();
      if (next) next();
      else budget.permits += 1;
      if (--budget.pending === 0) scopes.delete(organizationId);
    }
  };
}
