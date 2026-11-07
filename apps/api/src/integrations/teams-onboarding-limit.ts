import {
  pruneTeamsOnboardingLimits,
  releaseTeamsOnboardingReply,
  reserveTeamsOnboardingReply,
  type Database,
  type TeamsOnboardingGrant,
  type TeamsOnboardingWindow,
} from "@opengeni/db";

/**
 * Bounds the replies the bot sends to people in Teams organizations that have
 * not connected Opengeni (or are not admitted yet). Any Microsoft tenant can
 * message a Store app, so these replies must not answer every message forever.
 *
 * Per person: one reply per cooldown and a daily cap. Per tenant: a daily cap.
 * Overall: an hourly cap, so many tenants together stay bounded. Each kind of
 * reply has its own budget (`createTeamsOnboardingBudgets`). Budgets are
 * counted in the database across every API replica; when the database can't
 * be reached, each replica falls back to counting in its own memory. This is
 * abuse protection, not a billing meter.
 */
export type TeamsOnboardingLimits = {
  actorCooldownMs: number;
  actorDailyMax: number;
  tenantDailyMax: number;
  /** Across the deployment; per process when counted in memory. */
  overallHourlyMax: number;
  /** How many people and tenants a process tracks when counting in memory. */
  maxTrackedKeys: number;
};

export const DEFAULT_TEAMS_ONBOARDING_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 10 * 60_000,
  actorDailyMax: 6,
  tenantDailyMax: 200,
  overallHourlyMax: 2_000,
  maxTrackedKeys: 20_000,
};
/** Welcome cards sent because someone installed the app, not because they wrote. */
export const TEAMS_INSTALL_WELCOME_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 10 * 60_000,
  actorDailyMax: 1,
  // A tenant can pre-install the app for every user; only a few get a welcome.
  tenantDailyMax: 25,
  overallHourlyMax: 500,
  maxTrackedKeys: 20_000,
};
/** Not-available notices for tenants that aren't admitted yet. */
export const TEAMS_UNAVAILABLE_NOTICE_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 24 * 60 * 60_000,
  actorDailyMax: 1,
  tenantDailyMax: 20,
  overallHourlyMax: 200,
  maxTrackedKeys: 20_000,
};
/**
 * Short text replies with no card: reminders sent instead of silence once a
 * person's or tenant's cards are used up (they point to help, which always
 * answers with the way forward), and notices such as "files aren't supported
 * yet". They are cheap, so they have no cooldown and larger caps.
 */
export const TEAMS_ONBOARDING_REMINDER_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 0,
  actorDailyMax: 30,
  tenantDailyMax: 1_000,
  overallHourlyMax: 5_000,
  maxTrackedKeys: 20_000,
};

/**
 * Short text replies in group chats and channels (connect your organization
 * first, or this conversation isn't turned on). Everyone there sees them, so
 * each person gets at most one a minute.
 */
export const TEAMS_SHARED_NOTICE_LIMITS: TeamsOnboardingLimits = {
  actorCooldownMs: 60_000,
  actorDailyMax: 10,
  tenantDailyMax: 200,
  overallHourlyMax: 2_000,
  maxTrackedKeys: 20_000,
};

const DAY_MS = 24 * 60 * 60_000;
const HOUR_MS = 60 * 60_000;

type Window = { start: number; count: number; last: number };

/** A reserved reply, which can be given back if Teams clearly never received it. */
export type TeamsOnboardingReservation = { release(): Promise<void> };
/** One kind of onboarding reply's budget. */
export interface TeamsOnboardingBudget {
  /** Reserves one reply when every limit allows it; otherwise reserves nothing. */
  reserve(tenantId: string, actorId: string): Promise<TeamsOnboardingReservation | null>;
}

/** Counts one process's replies in memory. */
export class TeamsOnboardingLimiter implements TeamsOnboardingBudget {
  private readonly actors = new Map<string, Window>();
  private readonly tenants = new Map<string, Window>();
  private process: Window = { start: 0, count: 0, last: 0 };

  constructor(private readonly limits: TeamsOnboardingLimits = DEFAULT_TEAMS_ONBOARDING_LIMITS) {}

  async reserve(tenantId: string, actorId: string): Promise<TeamsOnboardingReservation | null> {
    const counted = this.reserveWindows(tenantId, actorId, Date.now());
    if (!counted) return null;
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        this.giveBack(counted, Date.now());
      },
    };
  }

  /** Reserves one reply when every limit allows it; otherwise reserves nothing. */
  tryReserve(tenantId: string, actorId: string, now = Date.now()): boolean {
    return this.reserveWindows(tenantId, actorId, now) !== null;
  }

  /**
   * Gives back the person's reservation whose reply Teams clearly never
   * received. Prefer a reservation's own `release()`, which gives back exactly
   * the windows it counted.
   */
  release(tenantId: string, actorId: string, now = Date.now()): void {
    const { tenantKey, actorKey } = this.keys(tenantId, actorId);
    const actor = this.actors.get(actorKey);
    const tenant = this.tenants.get(tenantKey);
    // Only a person's own reservation can be given back.
    if (!actor || actor.count === 0 || now - actor.start >= DAY_MS) return;
    this.giveBack({ actor, tenant: tenant ?? null }, now);
  }

  private keys(tenantId: string, actorId: string) {
    const tenantKey = tenantId.toLowerCase();
    return { tenantKey, actorKey: `${tenantKey}:${actorId.toLowerCase()}` };
  }

  private reserveWindows(
    tenantId: string,
    actorId: string,
    now: number,
  ): { actor: Window; tenant: Window | null } | null {
    const { tenantKey, actorKey } = this.keys(tenantId, actorId);
    const actor = this.current(this.actors, actorKey, DAY_MS, now);
    const tenant = this.current(this.tenants, tenantKey, DAY_MS, now);
    if (now - this.process.start >= HOUR_MS) this.process = { start: now, count: 0, last: 0 };
    if (
      (actor.count > 0 && now - actor.last < this.limits.actorCooldownMs) ||
      actor.count >= this.limits.actorDailyMax ||
      tenant.count >= this.limits.tenantDailyMax ||
      this.process.count >= this.limits.overallHourlyMax
    )
      return null;
    for (const window of [actor, tenant, this.process]) {
      window.count += 1;
      window.last = now;
    }
    this.store(this.actors, actorKey, actor);
    this.store(this.tenants, tenantKey, tenant);
    return { actor, tenant };
  }

  /**
   * Gives back one reply to the person's and tenant's windows, if they are
   * still current. The process's hourly count is kept: it bounds attempts, so
   * replies Teams keeps refusing (such as throttling) can't retry without
   * limit.
   */
  private giveBack(counted: { actor: Window; tenant: Window | null }, now: number): void {
    if (counted.actor.count === 0 || now - counted.actor.start >= DAY_MS) return;
    for (const window of [counted.actor, counted.tenant]) {
      if (!window || window.count === 0 || now - window.start >= DAY_MS) continue;
      window.count -= 1;
      // Without a reply in the window, there is no cooldown to wait out.
      if (window.count === 0) window.last = 0;
    }
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
 * Counts replies in the database, so every API replica shares one budget.
 * When the database fails, the reply is counted in this process's memory
 * instead: abuse protection stays in place and the person still gets an
 * answer.
 */
export class DurableTeamsOnboardingBudget implements TeamsOnboardingBudget {
  private readonly fallback: TeamsOnboardingLimiter;

  constructor(
    private readonly db: Database,
    private readonly name: string,
    private readonly limits: TeamsOnboardingLimits,
    private readonly onError: (error: unknown) => void = () => {},
  ) {
    this.fallback = new TeamsOnboardingLimiter(limits);
  }

  async reserve(tenantId: string, actorId: string): Promise<TeamsOnboardingReservation | null> {
    const [actor, ...rest] = this.windows(tenantId, actorId);
    let grant: TeamsOnboardingGrant | null;
    try {
      grant = await reserveTeamsOnboardingReply(this.db, [actor!, ...rest]);
    } catch (error) {
      this.onError(error);
      // Given back to the store that counted it.
      return await this.fallback.reserve(tenantId, actorId);
    }
    if (!grant) return null;
    void pruneTeamsOnboardingLimits(this.db).catch(() => {
      // Pruning is housekeeping; the next reply tries again.
    });
    let released = false;
    return {
      release: async () => {
        if (released) return;
        released = true;
        try {
          // The deployment's count is kept: it bounds attempts, so replies
          // Teams keeps refusing (such as throttling) can't retry without limit.
          await releaseTeamsOnboardingReply(this.db, grant, actor!, rest.slice(0, 1));
        } catch (error) {
          // The reservation then lapses with its window.
          this.onError(error);
        }
      },
    };
  }

  /** The person's window first, then the tenant's and the deployment's. */
  private windows(tenantId: string, actorId: string): TeamsOnboardingWindow[] {
    const tenant = tenantId.toLowerCase();
    const prefix = `teams-onboarding\n${this.name}`;
    return [
      {
        key: `${prefix}\nactor\n${tenant}\n${actorId.toLowerCase()}`,
        spanMs: DAY_MS,
        max: this.limits.actorDailyMax,
        cooldownMs: this.limits.actorCooldownMs,
      },
      { key: `${prefix}\ntenant\n${tenant}`, spanMs: DAY_MS, max: this.limits.tenantDailyMax },
      { key: `${prefix}\noverall`, spanMs: HOUR_MS, max: this.limits.overallHourlyMax },
    ];
  }
}
/**
 * Separate budgets, so notices for tenants that aren't admitted and welcomes
 * triggered by installs can never use up the replies to people in admitted
 * tenants who message the bot.
 */
export type TeamsOnboardingBudgets = {
  /** Connect cards for people who message the bot. */
  connect: TeamsOnboardingBudget;
  /** Connect cards for people who just installed the app. */
  installWelcome: TeamsOnboardingBudget;
  /** Not-available notices; never sent for installs. */
  unavailableNotice: TeamsOnboardingBudget;
  /** Short 1:1 text replies: reminders once cards are used up, and notices. */
  reminder: TeamsOnboardingBudget;
  /** Short text replies in group chats and channels. */
  sharedNotice: TeamsOnboardingBudget;
};
const BUDGET_LIMITS = {
  connect: DEFAULT_TEAMS_ONBOARDING_LIMITS,
  installWelcome: TEAMS_INSTALL_WELCOME_LIMITS,
  unavailableNotice: TEAMS_UNAVAILABLE_NOTICE_LIMITS,
  reminder: TEAMS_ONBOARDING_REMINDER_LIMITS,
  sharedNotice: TEAMS_SHARED_NOTICE_LIMITS,
} as const satisfies Record<keyof TeamsOnboardingBudgets, TeamsOnboardingLimits>;
/**
 * The budgets, counted in `db` across replicas, or in this process's memory
 * without one.
 */
export function createTeamsOnboardingBudgets(
  db?: Database,
  onError?: (error: unknown) => void,
): TeamsOnboardingBudgets {
  const budget = (name: keyof TeamsOnboardingBudgets) =>
    db
      ? new DurableTeamsOnboardingBudget(db, name, BUDGET_LIMITS[name], onError)
      : new TeamsOnboardingLimiter(BUDGET_LIMITS[name]);
  return {
    connect: budget("connect"),
    installWelcome: budget("installWelcome"),
    unavailableNotice: budget("unavailableNotice"),
    reminder: budget("reminder"),
    sharedNotice: budget("sharedNotice"),
  };
}
