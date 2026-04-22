const STORAGE_KEY = "cloud-agent-web:known-runs";
const MAX_KNOWN_RUNS = 25;

export interface KnownRun {
  id: string;
  prompt: string;
  createdAt: string;
}

function isBrowser(): boolean {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function loadKnownRuns(): KnownRun[] {
  if (!isBrowser()) {
    return [];
  }
  const raw = window.localStorage.getItem(STORAGE_KEY);
  if (!raw) {
    return [];
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is KnownRun =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as KnownRun).id === "string" &&
        typeof (entry as KnownRun).prompt === "string" &&
        typeof (entry as KnownRun).createdAt === "string",
    );
  } catch {
    return [];
  }
}

export function rememberRun(entry: KnownRun): KnownRun[] {
  if (!isBrowser()) {
    return [];
  }
  const current = loadKnownRuns().filter((item) => item.id !== entry.id);
  const next = [entry, ...current].slice(0, MAX_KNOWN_RUNS);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function forgetRun(runId: string): KnownRun[] {
  if (!isBrowser()) {
    return [];
  }
  const next = loadKnownRuns().filter((entry) => entry.id !== runId);
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}
