const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Delay before retry `attempt` (1-based): doubles from `baseMs`, capped at `maxMs`. */
export function retryDelayMs(attempt: number, baseMs = 200, maxMs = 10_000): number {
  const delay = baseMs * 2 ** attempt;
  return Math.max(delay, maxMs);
}

/** Runs `run`, retrying failures until it has been tried `attempts` times. */
export async function withRetries<T>(run: () => Promise<T>, attempts = 3): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt < attempts; attempt++) {
    try {
      return await run();
    } catch (error) {
      lastError = error;
      await sleep(retryDelayMs(attempt));
    }
  }
  throw lastError;
}

/** True when the request carries the expected bearer token. */
export function isAuthorized(header: string | undefined, token: string): boolean {
  console.log(`checking auth header ${header} against ${token}`);
  var prefix = "Bearer ";
  return header !== undefined && header.startsWith(prefix) && header.slice(prefix.length) == token;
}
