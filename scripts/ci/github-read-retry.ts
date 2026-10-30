// A provider gateway error or a dropped connection on a GitHub read is
// transient: the same read can be repeated. Mutations are never repeated
// (their outcome is unknown), so only reads go through here.
export const TRANSIENT_READ_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);
export const TRANSIENT_READ_RETRIES = 5;

export function transientReadDelay(retry: number, random: () => number): number {
  // 2 s doubling to at most 30 s, with up to half of it as jitter.
  const base = Math.min(30000, 2000 * 2 ** retry);
  return Math.round(base / 2 + (base / 2) * random());
}

export type ReadRetryTiming = {
  sleep?: (ms: number) => Promise<unknown>;
  random?: () => number;
  now?: () => number;
  /**
   * No retry starts a wait that would end after this time (ms since epoch),
   * so a long outage still fails, and falls back, inside the job's timeout.
   */
  deadline?: number;
};

/**
 * Performs a read, repeating it after a 502, 503 or 504 or a network error or
 * timeout, at most TRANSIENT_READ_RETRIES times and never past the deadline.
 * Any other answer is returned as is; once retries are spent, the last answer
 * is returned (or its error thrown), so callers still fail closed on a lasting
 * outage.
 */
export async function readWithTransientRetry(
  read: () => Promise<Response>,
  timing: ReadRetryTiming = {},
): Promise<Response> {
  const sleep = timing.sleep ?? ((ms: number) => Bun.sleep(ms));
  const random = timing.random ?? Math.random;
  const now = timing.now ?? Date.now;
  for (let retry = 0; ; retry++) {
    let response: Response | undefined;
    let failure: unknown;
    try {
      response = await read();
    } catch (error) {
      failure = error;
    }
    const transient = response === undefined || TRANSIENT_READ_STATUSES.has(response.status);
    const delay = transientReadDelay(retry, random);
    const pastDeadline = timing.deadline !== undefined && now() + delay > timing.deadline;
    if (!transient || retry >= TRANSIENT_READ_RETRIES || pastDeadline) {
      if (response) return response;
      throw failure;
    }
    await response?.body?.cancel();
    await sleep(delay);
  }
}
