import { readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { OwnedManagedBrowserProcess } from "./runner";

/**
 * A managed browser a controller left running when it shut down (an agent
 * update or restart), so its successor can adopt it with its page state. The
 * successor only adopts a browser when its session is used again; a browser
 * whose session never comes back would otherwise run forever. The record lets
 * the successor stop it once it has been unused for the idle release time,
 * exactly as if the original controller had released it.
 */
export type DetachedBrowserRecord = {
  version: 1;
  browserSessionId: string;
  /** When a request last reached the browser before it was handed off
   * (milliseconds since the epoch on the supervisor clock). */
  lastUsedAt: number;
  /** The deadline of a deliberate wait by the browser's agent session that
   * keeps it past the idle release time (see `waitHoldEnds`), if any. Older
   * controllers ignore it and stop the browser by `lastUsedAt` alone. */
  waitHoldUntil?: number;
  process: OwnedManagedBrowserProcess;
};

const RECORD_NAME = "detached-browser.json";
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_RECORD_BYTES = 8_192;

export function detachedBrowserRecordPath(sessionDirectory: string): string {
  return join(sessionDirectory, RECORD_NAME);
}

export async function writeDetachedBrowserRecord(
  sessionDirectory: string,
  record: DetachedBrowserRecord,
): Promise<void> {
  const path = detachedBrowserRecordPath(sessionDirectory);
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
  await rename(temporary, path);
}

export async function removeDetachedBrowserRecord(sessionDirectory: string): Promise<void> {
  await rm(detachedBrowserRecordPath(sessionDirectory), { force: true });
}

/** Every readable record under the supervisor root. A record that cannot be
 * read or does not match its directory is skipped, never acted on. */
export async function readDetachedBrowserRecords(
  rootDirectory: string,
): Promise<DetachedBrowserRecord[]> {
  const sessionsDirectory = join(rootDirectory, "sessions");
  let names: string[];
  try {
    names = await readdir(sessionsDirectory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: DetachedBrowserRecord[] = [];
  for (const name of names) {
    if (!SESSION_ID.test(name)) continue;
    let text: string;
    try {
      text = await readFile(detachedBrowserRecordPath(join(sessionsDirectory, name)), "utf8");
    } catch {
      continue;
    }
    if (text.length > MAX_RECORD_BYTES) continue;
    const record = parseDetachedBrowserRecord(text);
    if (record?.browserSessionId === name) records.push(record);
  }
  return records;
}

function parseDetachedBrowserRecord(text: string): DetachedBrowserRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const record = value as Partial<DetachedBrowserRecord>;
  const owned = record.process as Partial<OwnedManagedBrowserProcess> | undefined;
  if (
    record.version !== 1 ||
    typeof record.browserSessionId !== "string" ||
    typeof record.lastUsedAt !== "number" ||
    !Number.isFinite(record.lastUsedAt) ||
    !owned ||
    typeof owned.pid !== "number" ||
    !Number.isSafeInteger(owned.pid) ||
    owned.pid <= 0 ||
    typeof owned.birth !== "string" ||
    typeof owned.executablePath !== "string" ||
    typeof owned.profileDirectory !== "string" ||
    typeof owned.cdpEndpoint !== "string"
  )
    return null;
  return {
    version: 1,
    browserSessionId: record.browserSessionId,
    lastUsedAt: record.lastUsedAt,
    ...(typeof record.waitHoldUntil === "number" && Number.isFinite(record.waitHoldUntil)
      ? { waitHoldUntil: record.waitHoldUntil }
      : {}),
    process: {
      pid: owned.pid,
      birth: owned.birth,
      executablePath: owned.executablePath,
      profileDirectory: owned.profileDirectory,
      cdpEndpoint: owned.cdpEndpoint,
    },
  };
}
