/** Pure limit projections. All timestamps are milliseconds; no currency leaves this module. */
export type SubscriptionUsagePoolWindowId = "five_hour" | "weekly";

export type SubscriptionUsagePoolInput = {
  provider: string;
  now: number;
  accounts: Array<{
    id: string;
    label: string;
    plan: string | null;
    /**
     * Adapter-owned relative tier estimate, not call units. Unknown tiers default to 1.
     * Keep provider/tier tables outside the provider-neutral policy package.
     * The same tier scale must be used for every account in this pool.
     */
    planWeight?: number;
    windows: Array<{
      id: SubscriptionUsagePoolWindowId;
      usedPercent: number | null;
      resetsAt: number | null;
      observedAt: number | null;
    }>;
  }>;
  readings: Array<{
    connectionId: string;
    window: SubscriptionUsagePoolWindowId;
    usedPercent: number;
    resetsAt: number | null;
    observedAt: number;
  }>;
  /** Attributed, estimated API-equivalent usage; used only for calibration and shape. */
  calls: Array<{ connectionId: string; at: number; units: number }>;
  historyStart: number | null;
};

export type SubscriptionUsagePoolAccount = {
  id: string;
  label: string;
  remainingPercent: number | null;
  resetsAt: number | null;
  weight: number;
  weightBasis: "observed" | "plan_estimate";
  observedAt: number | null;
};

export type SubscriptionUsagePoolForecast = {
  kind: "runs_out" | "unused" | "insufficient_history";
  basis: string;
  runsOutAt: number | null;
  nextResetAt: number | null;
  /** Fraction of original full capacity discarded at each account's FIRST upcoming reset. */
  unusedPercent: number | null;
  /** Lowest aggregate remaining percentage, sampled BEFORE reset refills. */
  lowestPercent: number | null;
  historyDays: number;
};

export type SubscriptionUsagePool = {
  provider: string;
  observedAt: number | null;
  windows: Array<{
    id: SubscriptionUsagePoolWindowId;
    remainingPercent: number | null;
    accounts: SubscriptionUsagePoolAccount[];
    forecast: SubscriptionUsagePoolForecast;
  }>;
};

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
const EPSILON = 1e-10;
const WINDOW_DURATION = { five_hour: 5 * HOUR, weekly: WEEK };
// A reading is not refreshed by the passage of a reset. These TTLs are presentation policy.
const FRESHNESS = { five_hour: HOUR, weekly: DAY };
const WINDOW_IDS: SubscriptionUsagePoolWindowId[] = ["five_hour", "weekly"];

type Reading = { usedPercent: number; resetsAt: number | null; observedAt: number };
type Call = SubscriptionUsagePoolInput["calls"][number];
type Segment = { start: number; end: number; reset: number; fraction: number; calls: Call[] };
type Bucket = { amount: number; hours: number };
type Pace = {
  profile: number[];
  buckets: Map<number, Bucket>;
  fallback: boolean;
  callShape: boolean;
};

const finite = (value: number | null | undefined): value is number =>
  typeof value === "number" && Number.isFinite(value);
const percent = (value: number | null): value is number =>
  finite(value) && value >= 0 && value <= 100;
const clamp = (value: number, low: number, high: number) => Math.min(high, Math.max(low, value));
const sum = (values: number[]) => values.reduce((total, value) => total + value, 0);
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}
function hourOfWeek(at: number): number {
  const date = new Date(at);
  return ((date.getUTCDay() + 6) % 7) * 24 + date.getUTCHours();
}

/**
 * Both windows and every supplied account stay visible, including missing windows.
 * Snapshots are authoritative for CURRENT remaining; historical readings never fill a
 * missing snapshot. A partial pool has no whole-pool number or reassuring forecast.
 * Call units never set demand magnitude: stable percentage movements include usage
 * outside this application. Calibration is only a relative proxy for usable capacity.
 */
export function buildSubscriptionUsagePool(
  input: SubscriptionUsagePoolInput,
): SubscriptionUsagePool {
  if (!finite(input.now) || Math.abs(input.now) > 8.64e15 - 2 * WEEK) {
    throw new RangeError("now must be a valid millisecond timestamp");
  }
  const ids = new Set(input.accounts.map((account) => account.id));
  if (ids.size !== input.accounts.length) throw new RangeError("account ids must be unique");
  const since = Math.max(
    input.now - 2 * WEEK,
    finite(input.historyStart) ? Math.min(input.now, input.historyStart) : -Infinity,
  );
  const callsByAccount = new Map<string, Call[]>();
  for (const call of input.calls) {
    if (
      !ids.has(call.connectionId) ||
      !finite(call.at) ||
      call.at < since ||
      call.at > input.now ||
      !finite(call.units) ||
      call.units <= 0
    )
      continue;
    const calls = callsByAccount.get(call.connectionId) ?? [];
    calls.push(call);
    callsByAccount.set(call.connectionId, calls);
  }
  for (const calls of callsByAccount.values()) calls.sort((a, b) => a.at - b.at);
  const readingsByAccount = new Map<string, Map<SubscriptionUsagePoolWindowId, Reading[]>>();
  for (const reading of input.readings) {
    if (
      !ids.has(reading.connectionId) ||
      !percent(reading.usedPercent) ||
      !finite(reading.observedAt) ||
      reading.observedAt < since ||
      reading.observedAt > input.now
    )
      continue;
    const windows = readingsByAccount.get(reading.connectionId) ?? new Map();
    const readings = windows.get(reading.window) ?? [];
    readings.push(reading);
    windows.set(reading.window, readings);
    readingsByAccount.set(reading.connectionId, windows);
  }

  const windows = WINDOW_IDS.map((id) => {
    const duration = WINDOW_DURATION[id];
    const data = input.accounts.map((account) => {
      // Newest supplied snapshot wins; an explicit null must not resurrect older quota.
      const snapshot = [...account.windows.filter((window) => window.id === id)].sort(
        (a, b) => (b.observedAt ?? -Infinity) - (a.observedAt ?? -Infinity),
      )[0];
      const observedAt =
        finite(snapshot?.observedAt) && snapshot.observedAt <= input.now
          ? snapshot.observedAt
          : null;
      const resetsAt = finite(snapshot?.resetsAt) ? snapshot.resetsAt : null;
      const current =
        observedAt !== null &&
        input.now - observedAt <= FRESHNESS[id] &&
        (resetsAt === null || (resetsAt > input.now && resetsAt <= observedAt + duration));
      const remainingPercent =
        current && snapshot && percent(snapshot.usedPercent) ? 100 - snapshot.usedPercent : null;
      const readings = [...(readingsByAccount.get(account.id)?.get(id) ?? [])];
      if (snapshot && percent(snapshot.usedPercent) && observedAt !== null && observedAt >= since) {
        readings.push({ usedPercent: snapshot.usedPercent, observedAt, resetsAt });
      }
      const segments = stableSegments(readings, callsByAccount.get(account.id) ?? [], duration);
      const planWeight =
        finite(account.planWeight) && account.planWeight > 0 ? account.planWeight : 1;
      return {
        account,
        observedAt,
        resetsAt,
        remainingPercent,
        segments,
        planWeight,
        calibrated: calibratedCapacity(segments),
        readings,
      };
    });

    // Convert measured capacities to the SAME dimensionless scale as plan estimates.
    // Known-tier anchors take priority; otherwise the median measured account is one tier.
    const knownAnchors = data.filter(
      (row) =>
        row.calibrated !== null && finite(row.account.planWeight) && row.account.planWeight > 0,
    );
    const anchors = knownAnchors.length
      ? knownAnchors
      : data.filter((row) => row.calibrated !== null);
    const anchor = anchors.length
      ? median(anchors.map((row) => row.calibrated! / row.planWeight))
      : 1;
    const accounts: SubscriptionUsagePoolAccount[] = data.map((row) => ({
      id: row.account.id,
      label: row.account.label,
      remainingPercent: row.remainingPercent,
      resetsAt: row.resetsAt,
      weight: clamp(
        row.calibrated === null ? row.planWeight : row.calibrated / anchor,
        0.01,
        10_000,
      ),
      weightBasis: row.calibrated === null ? "plan_estimate" : "observed",
      observedAt: row.observedAt,
    }));
    const totalWeight = sum(accounts.map((account) => account.weight));
    const complete =
      accounts.length > 0 && accounts.every((account) => account.remainingPercent !== null);
    const remainingPercent = complete
      ? sum(accounts.map((account) => account.weight * account.remainingPercent!)) / totalWeight
      : null;
    const earliest = data.reduce(
      (at, row) =>
        row.readings.reduce((minimum, reading) => Math.min(minimum, reading.observedAt), at),
      input.now,
    );
    const historyDays = (input.now - Math.max(since, earliest)) / DAY;
    const resets = accounts
      .map((account) => account.resetsAt)
      .filter((at): at is number => at !== null && at > input.now && at <= input.now + duration);
    const nextResetAt = resets.length ? Math.min(...resets) : null;
    const insufficient = (basis: string): SubscriptionUsagePoolForecast => ({
      kind: "insufficient_history",
      basis,
      runsOutAt: null,
      nextResetAt,
      unusedPercent: null,
      lowestPercent: null,
      historyDays,
    });
    let forecast: SubscriptionUsagePoolForecast;
    if (!complete) {
      forecast = insufficient(
        "Missing or stale account/window observations; whole-pool coverage is unknown.",
      );
    } else if (remainingPercent === 0) {
      forecast = {
        kind: "runs_out",
        basis: "Observed pool exhaustion.",
        runsOutAt: input.now,
        nextResetAt,
        unusedPercent: null,
        lowestPercent: 0,
        historyDays,
      };
    } else if (resets.length !== accounts.length) {
      forecast = insufficient(
        "A future reset is unknown; remaining limits are observed, not forecast.",
      );
    } else {
      const paces = data.map((row, index) =>
        buildPace(row.segments, accounts[index]!, duration, input.now),
      );
      if (paces.some((pace) => pace === null)) {
        forecast = insufficient(
          "Insufficient observed activity coverage; absence of calls is not zero demand.",
        );
      } else {
        const availablePaces = paces as Pace[];
        const profile = Array.from({ length: 168 }, (_, hour) =>
          sum(availablePaces.map((pace) => pace.profile[hour]!)),
        );
        const trend = weeklyTrend(availablePaces, input.now);
        const recent = id === "five_hour" ? lastHourAdjustment(availablePaces, input.now) : 1;
        const scale = clamp(trend * recent, 0.5, 2);
        const basis = [
          availablePaces.some((pace) => pace.fallback)
            ? "Last-reset average fallback"
            : "Observed percentage movements",
          historyDays >= 7
            ? "last 7 days"
            : `${Math.max(1, Math.ceil(historyDays))} days of history`,
          `same-hours weekly trend ${trend.toFixed(2)}x`,
          ...(id === "five_hour" ? [`last-hour adjustment ${recent.toFixed(2)}x`] : []),
        ].join("; ");
        forecast = simulate(
          accounts,
          profile.map((rate) => rate * scale),
          input.now,
          duration,
          historyDays,
          basis,
        );
      }
    }
    return { id, remainingPercent, accounts, forecast };
  });
  const observations = windows
    .flatMap((window) => window.accounts.map((account) => account.observedAt))
    .filter((at): at is number => at !== null);
  return {
    provider: input.provider,
    observedAt: observations.length ? Math.max(...observations) : null,
    windows,
  };
}

function stableSegments(readings: Reading[], calls: Call[], duration: number): Segment[] {
  // Identical duplicates are harmless. Conflicting same-time readings break continuity.
  const grouped = new Map<number, Reading[]>();
  for (const reading of readings) {
    const group = grouped.get(reading.observedAt) ?? [];
    group.push(reading);
    grouped.set(reading.observedAt, group);
  }
  const ordered = [...grouped]
    .sort(([a], [b]) => a - b)
    .map(([, group]) =>
      group.every(
        (row) => row.usedPercent === group[0]!.usedPercent && row.resetsAt === group[0]!.resetsAt,
      )
        ? group[0]!
        : null,
    );
  const result: Segment[] = [];
  let callIndex = 0;
  let before: Reading | null = null;
  for (const after of ordered) {
    if (
      !before ||
      !after ||
      !finite(before.resetsAt) ||
      before.resetsAt !== after.resetsAt ||
      before.resetsAt < after.observedAt ||
      before.resetsAt > before.observedAt + duration ||
      after.observedAt - before.observedAt > Math.min(duration, DAY) ||
      after.usedPercent < before.usedPercent ||
      before.usedPercent === 100
    ) {
      before = after;
      continue;
    }
    // Polling more often than five minutes accumulates into a sample, rather than
    // dropping every adjacent pair. A correction/reset still breaks the chain above.
    if (after.observedAt - before.observedAt < HOUR / 12) continue;
    while (callIndex < calls.length && calls[callIndex]!.at <= before.observedAt) callIndex++;
    const start = callIndex;
    while (callIndex < calls.length && calls[callIndex]!.at <= after.observedAt) callIndex++;
    result.push({
      start: before.observedAt,
      end: after.observedAt,
      reset: before.resetsAt,
      fraction: (after.usedPercent - before.usedPercent) / 100,
      calls: calls.slice(start, callIndex),
    });
    before = after;
  }
  return result;
}

function calibratedCapacity(segments: Segment[]): number | null {
  // Accumulate quantized/small movements without ever spanning a gap or reset.
  const positive: Segment[] = [];
  let pending: Segment | null = null;
  for (const segment of segments) {
    if (pending && pending.end === segment.start && pending.reset === segment.reset) {
      pending.end = segment.end;
      pending.fraction += segment.fraction;
      for (const call of segment.calls) pending.calls.push(call);
    } else {
      pending = { ...segment, calls: [...segment.calls] };
    }
    if (pending.fraction >= 0.01 - EPSILON) {
      positive.push(pending);
      pending = null;
    }
  }
  const paired = positive
    .map((segment) => ({
      segment,
      capacity: sum(segment.calls.map((call) => call.units)) / segment.fraction,
    }))
    .filter((sample) => finite(sample.capacity) && sample.capacity > 0);
  if (paired.length < 3) return null;
  const center = median(paired.map((sample) => sample.capacity));
  const stable = paired.filter(
    (sample) => sample.capacity >= center / 2 && sample.capacity <= center * 2,
  );
  // Three samples, six calls, ten percentage points, an hour, 60% movement coverage,
  // and median absolute dispersion <= 35%. Reset crossings/corrections never calibrate.
  if (
    stable.length < 3 ||
    stable.length < paired.length * 0.6 ||
    sum(stable.map(({ segment }) => segment.calls.length)) < 6 ||
    sum(stable.map(({ segment }) => segment.fraction)) < 0.1 ||
    sum(stable.map(({ segment }) => segment.end - segment.start)) < HOUR ||
    sum(stable.map(({ segment }) => segment.fraction)) <
      sum(segments.map((segment) => segment.fraction)) * 0.6 ||
    median(stable.map((sample) => Math.abs(sample.capacity - center))) > center * 0.35
  )
    return null;
  return median(stable.map((sample) => sample.capacity));
}

function addBucket(buckets: Map<number, Bucket>, at: number, amount: number, hours: number): void {
  const previous = buckets.get(at) ?? { amount: 0, hours: 0 };
  buckets.set(at, { amount: previous.amount + amount, hours: previous.hours + hours });
}

function buildPace(
  segments: Segment[],
  account: SubscriptionUsagePoolAccount,
  duration: number,
  now: number,
): Pace | null {
  const buckets = new Map<number, Bucket>();
  let callShape = false;
  for (const segment of segments) {
    const hours = (segment.end - segment.start) / HOUR;
    const shape = new Map<number, number>();
    const reliableCalls = segment.calls.length >= 3 && segment.fraction > 0;
    if (reliableCalls) {
      const cap = median(segment.calls.map((call) => call.units)) * 3;
      for (const call of segment.calls) {
        // An endpoint call belongs to the interval ending there, not a future hour.
        const hour = Math.floor(Math.min(call.at, segment.end - 1) / HOUR) * HOUR;
        shape.set(hour, (shape.get(hour) ?? 0) + Math.min(call.units, cap));
      }
    }
    const shapeTotal = sum([...shape.values()]);
    callShape ||= shapeTotal > 0;
    for (let at = Math.floor(segment.start / HOUR) * HOUR; at < segment.end; at += HOUR) {
      const overlap = (Math.min(at + HOUR, segment.end) - Math.max(at, segment.start)) / HOUR;
      // Preserve total observed movement, with a uniform floor for unattributed activity.
      const fraction =
        shapeTotal > 0
          ? (0.25 * overlap) / hours + (0.75 * (shape.get(at) ?? 0)) / shapeTotal
          : overlap / hours;
      addBucket(buckets, at, segment.fraction * account.weight * fraction, overlap);
    }
  }
  const recentSegments = segments.filter((segment) => segment.end > now - WEEK);
  const recent = [...buckets].filter(([at]) => at + HOUR > now - WEEK);
  const coverage = sum(recent.map(([, bucket]) => bucket.hours));
  // Explicit flat percentage observations ARE evidence of zero use; an empty call log is not.
  if (
    recentSegments.length < 2 ||
    coverage < 1 ||
    !recentSegments.some(
      (segment) => segment.end >= now - FRESHNESS[duration === WEEK ? "weekly" : "five_hour"],
    )
  ) {
    const elapsed =
      account.resetsAt !== null && account.observedAt !== null
        ? (account.observedAt - (account.resetsAt - duration)) / HOUR
        : 0;
    if (
      account.remainingPercent === null ||
      account.remainingPercent >= 100 ||
      elapsed < 0.25 ||
      elapsed > duration / HOUR
    )
      return null;
    const rate = (account.weight * (1 - account.remainingPercent / 100)) / elapsed;
    return { buckets, profile: Array(168).fill(rate), fallback: true, callShape: false };
  }
  const positiveRates = [...buckets.values()]
    .filter((bucket) => bucket.amount > 0)
    .map((bucket) => bucket.amount / bucket.hours);
  const cap = positiveRates.length >= 3 ? median(positiveRates) * 3 : Infinity;
  // Winsorization damps isolated activity spikes without turning genuine idle observations into gaps.
  for (const bucket of buckets.values())
    bucket.amount = Math.min(bucket.amount, cap * bucket.hours);
  const average = sum(recent.map(([, bucket]) => bucket.amount)) / coverage;
  const profile = Array<number>(168).fill(average);
  const slots = new Map<number, Bucket>();
  for (const [at, bucket] of recent) addBucket(slots, hourOfWeek(at), bucket.amount, bucket.hours);
  for (const [hour, bucket] of slots) {
    const confidence = Math.min(1, bucket.hours);
    profile[hour] = (confidence * bucket.amount) / bucket.hours + (1 - confidence) * average;
  }
  return { buckets, profile, fallback: false, callShape };
}

function coveredRate(paces: Pace[], at: number): number | null {
  const buckets = paces.map((pace) => pace.buckets.get(at));
  if (buckets.some((bucket) => !bucket || bucket.hours < 0.75)) return null;
  return sum(buckets.map((bucket) => bucket!.amount / bucket!.hours));
}

function weeklyTrend(paces: Pace[], now: number): number {
  const completed = Math.floor(now / HOUR) * HOUR;
  const weekStart = completed - hourOfWeek(completed) * HOUR;
  let current = 0;
  let previous = 0;
  let pairs = 0;
  for (let at = weekStart; at < completed; at += HOUR) {
    const here = coveredRate(paces, at);
    const there = coveredRate(paces, at - WEEK);
    if (here === null || there === null) continue;
    current += here;
    previous += there;
    pairs++;
  }
  return pairs >= 3 && previous > EPSILON ? clamp(Math.sqrt(current / previous), 0.5, 2) : 1;
}

function lastHourAdjustment(paces: Pace[], now: number): number {
  // Use the last FULL hour: partial current-hour observations must not inflate the pace.
  const at = Math.floor(now / HOUR) * HOUR - HOUR;
  const actual = coveredRate(paces, at);
  const average = sum(paces.map((pace) => sum(pace.profile) / 168));
  return actual !== null && average > EPSILON ? clamp(Math.sqrt(actual / average), 0.5, 2) : 1;
}

function simulate(
  accounts: SubscriptionUsagePoolAccount[],
  profile: number[],
  now: number,
  duration: number,
  historyDays: number,
  basis: string,
): SubscriptionUsagePoolForecast {
  const total = sum(accounts.map((account) => account.weight));
  const remaining = accounts.map((account) => (account.weight * account.remainingPercent!) / 100);
  const resets = accounts.map((account) => account.resetsAt!);
  const horizon = Math.min(now + duration, Math.max(...resets));
  let at = now;
  let lowest = sum(remaining);
  let unused = 0;
  let runsOutAt: number | null = null;
  while (at < horizon) {
    const nextReset = Math.min(...resets.filter((reset) => reset > at));
    const end = Math.min(horizon, (Math.floor(at / HOUR) + 1) * HOUR, nextReset);
    const rate = profile[hourOfWeek(at)]!;
    const demand = (rate * (end - at)) / HOUR;
    const available = sum(remaining);
    if (rate > 0 && demand >= available && runsOutAt === null) {
      runsOutAt = at + (available / rate) * HOUR;
    }
    consume(remaining, accounts, Math.min(demand, available));
    lowest = Math.min(lowest, sum(remaining));
    // Do not carry unserved demand as debt into the next account's renewed window.
    for (let index = 0; index < accounts.length; index++) {
      if (resets[index] === end) {
        unused += remaining[index]!;
        remaining[index] = accounts[index]!.weight;
      }
    }
    at = end;
  }
  const nextResetAt = Math.min(...resets.filter((reset) => reset >= (runsOutAt ?? now)));
  return {
    kind: runsOutAt === null ? "unused" : "runs_out",
    basis,
    runsOutAt,
    nextResetAt: finite(nextResetAt) ? nextResetAt : null,
    unusedPercent: runsOutAt === null ? clamp((unused / total) * 100, 0, 100) : null,
    lowestPercent: clamp((lowest / total) * 100, 0, 100),
    historyDays,
  };
}

/** Water-fill by relative capacity, reallocating only what a depleted account cannot serve. */
function consume(
  remaining: number[],
  accounts: SubscriptionUsagePoolAccount[],
  demand: number,
): void {
  let active = remaining
    .map((amount, index) => ({ amount, index }))
    .filter((row) => row.amount > 0);
  while (demand > EPSILON && active.length) {
    const totalWeight = sum(active.map((row) => accounts[row.index]!.weight));
    let consumed = 0;
    for (const { index } of active) {
      const amount = Math.min(remaining[index]!, (demand * accounts[index]!.weight) / totalWeight);
      remaining[index] = Math.max(0, remaining[index]! - amount);
      consumed += amount;
    }
    demand = Math.max(0, demand - consumed);
    active = active.filter((row) => remaining[row.index]! > EPSILON);
  }
}
