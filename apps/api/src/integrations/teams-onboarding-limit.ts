/**
 * Bounds the replies the bot sends to people in Teams organizations that have
 * not connected Opengeni (or are not admitted yet). Any Microsoft tenant can
 * message a Store app, so these replies must not answer every message forever.
 *
 * Per person: one reply per cooldown and a daily cap. Per tenant: a daily cap.
 * Per process: an hourly cap, so many tenants together stay bounded. Each kind
 * of reply has its own budget (`createTeamsOnboardingBudgets`). The
 * tables are size-bounded; this is abuse protection for one API replica, not a
 * billing meter, and resets on restart.
 */
export type TeamsOnboardingLimits = {
  actorCooldownMs: number;
  actorDailyMax: number;
  tenantDailyMax: number;
  processHourlyMax: number;
  maxTrackedKeys: number;
};

export const DEFAULT_TEAMS_ONBOARDING_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 10 * 60_000,
  actorDailyMax: 6,
  tenantDailyMax: 200,
  processHourlyMax: 2_000,
  maxTrackedKeys: 20_000,
};
/** Welcome cards sent because someone installed the app, not because they wrote. */
export const TEAMS_INSTALL_WELCOME_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 10 * 60_000,
  actorDailyMax: 1,
  // A tenant can pre-install the app for every user; only a few get a welcome.
  tenantDailyMax: 25,
  processHourlyMax: 500,
  maxTrackedKeys: 20_000,
};
/** Not-available notices for tenants that aren't admitted yet. */
export const TEAMS_UNAVAILABLE_NOTICE_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 24 * 60 * 60_000,
  actorDailyMax: 1,
  tenantDailyMax: 20,
  processHourlyMax: 200,
  maxTrackedKeys: 20_000,
};

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

type Window = { start: number; count: number; last: number };

export class TeamsOnboardingLimiter {
  private readonly actors = new Map<string, Window>();
  private readonly tenants = new Map<string, Window>();
  private process: Window = { start: 0, count: 0, last: 0 };

  constructor(private readonly limits: TeamsOnboardingLimits = DEFAULT_TEAMS_ONBOARDING_LIMITS) {}

  /** Reserves one reply when every limit allows it; otherwise reserves nothing. */
  tryReserve(tenantId: string, actorId: string, now = Date.now()): boolean {
    const tenantKey = tenantId.toLowerCase();
    const actorKey = `${tenantKey}:${actorId.toLowerCase()}`;
    const actor = this.current(this.actors, actorKey, DAY_MS, now);
    const tenant = this.current(this.tenants, tenantKey, DAY_MS, now);
    if (now - this.process.start >= HOUR_MS) this.process = { start: now, count: 0, last: 0 };
    if (
      (actor.count > 0 && now - actor.last < this.limits.actorCooldownMs) ||
      actor.count >= this.limits.actorDailyMax ||
      tenant.count >= this.limits.tenantDailyMax ||
      this.process.count >= this.limits.processHourlyMax
    )
      return false;
    for (const window of [actor, tenant, this.process]) {
      window.count += 1;
      window.last = now;
    }
    this.store(this.actors, actorKey, actor);
    this.store(this.tenants, tenantKey, tenant);
    return true;
  }

  private current(map: Map<string, Window>, key: string, span: number, now: number): Window {
    const value = map.get(key);
    return value && now - value.start < span ? value : { start: now, count: 0, last: 0 };
  }

  private store(map: Map<string, Window>, key: string, value: Window): void {
    // Re-insert so iteration order is least recently used first.
    map.delete(key);
    map.set(key, value);
    while (map.size > this.limits.maxTrackedKeys) {
      const oldest = map.keys().next().value;
      if (oldest === undefined) break;
      map.delete(oldest);
    }
  }
}
/**
 * Separate budgets, so notices for tenants that aren't admitted and welcomes
 * triggered by installs can never use up the replies to people in admitted
 * tenants who message the bot.
 */
export type TeamsOnboardingBudgets = {
  /** Connect cards for people who message the bot. */
  connect: TeamsOnboardingLimiter;
  /** Connect cards for people who just installed the app. */
  installWelcome: TeamsOnboardingLimiter;
  /** Not-available notices; never sent for installs. */
  unavailableNotice: TeamsOnboardingLimiter;
};
export function createTeamsOnboardingBudgets(): TeamsOnboardingBudgets {
  return {
    connect: new TeamsOnboardingLimiter(DEFAULT_TEAMS_ONBOARDING_LIMITS),
    installWelcome: new TeamsOnboardingLimiter(TEAMS_INSTALL_WELCOME_LIMITS),
    unavailableNotice: new TeamsOnboardingLimiter(TEAMS_UNAVAILABLE_NOTICE_LIMITS),
  };
}
