import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { dataDirectory } from "./config";

/**
 * App-owned facts Opengeni has no field for: the look of an agent (its icon),
 * its one-line description, a per-agent effort override, usage
 * history for the self-organizing sidebar, and which agent action blocks have
 * already been applied. Conversation, identity, instructions, pins, unread and
 * visibility stay in Opengeni.
 */
export type AgentProfile = {
  workspaceId: string;
  sessionId: string;
  /** A name from AGENT_ICONS; the app falls back to a keyword match. */
  icon: string | null;
  description: string | null;
  effort: string | null;
  name: string | null;
  role: "main" | "agent" | null;
  customInstructions: string | null;
  instructionsVersion: number;
  updatedAt: string;
};

export type UsageSummary = {
  sessionId: string;
  score: number;
  lastUsedAt: string | null;
};

mkdirSync(dataDirectory, { recursive: true });
export const db = new Database(join(dataDirectory, "simple.sqlite"), {
  create: true,
});
db.exec("PRAGMA journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS agent_profiles (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL PRIMARY KEY,
    icon TEXT,
    description TEXT,
    effort TEXT,
    name TEXT,
    role TEXT,
    custom_instructions TEXT,
    instructions_version INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS usage_events (
    workspace_id TEXT NOT NULL,
    session_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS usage_events_ws ON usage_events (workspace_id, session_id, at);
  CREATE TABLE IF NOT EXISTS applied_blocks (
    block_key TEXT NOT NULL PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    state TEXT NOT NULL,
    result TEXT,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS prefs (
    workspace_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    PRIMARY KEY (workspace_id, key)
  );
`);
const profileColumns = db
  .query<{ name: string }, []>("SELECT name FROM pragma_table_info('agent_profiles')")
  .all()
  .map((column) => column.name);
// Databases from before icons keep their old avatar columns unused.
if (!profileColumns.includes("icon")) db.exec("ALTER TABLE agent_profiles ADD COLUMN icon TEXT");
const blockColumns = db
  .query<{ name: string }, []>("SELECT name FROM pragma_table_info('applied_blocks')")
  .all()
  .map((column) => column.name);
if (!blockColumns.includes("owner")) db.exec("ALTER TABLE applied_blocks ADD COLUMN owner TEXT");

type ProfileRow = {
  workspace_id: string;
  session_id: string;
  icon: string | null;
  description: string | null;
  effort: string | null;
  name: string | null;
  role: "main" | "agent" | null;
  custom_instructions: string | null;
  instructions_version: number;
  updated_at: string;
};

function toProfile(row: ProfileRow): AgentProfile {
  return {
    workspaceId: row.workspace_id,
    sessionId: row.session_id,
    icon: row.icon,
    description: row.description,
    effort: row.effort,
    name: row.name,
    role: row.role,
    customInstructions: row.custom_instructions,
    instructionsVersion: row.instructions_version,
    updatedAt: row.updated_at,
  };
}

export function listProfiles(workspaceId: string): AgentProfile[] {
  return db
    .query<ProfileRow, [string]>("SELECT * FROM agent_profiles WHERE workspace_id = ?")
    .all(workspaceId)
    .map(toProfile);
}

export function getProfile(sessionId: string): AgentProfile | null {
  const row = db
    .query<ProfileRow, [string]>("SELECT * FROM agent_profiles WHERE session_id = ?")
    .get(sessionId);
  return row ? toProfile(row) : null;
}

const PROFILE_FIELDS = {
  icon: "icon",
  description: "description",
  effort: "effort",
  name: "name",
  role: "role",
  customInstructions: "custom_instructions",
  instructionsVersion: "instructions_version",
} as const satisfies Partial<Record<keyof AgentProfile, string>>;

export type ProfilePatch = Partial<Pick<AgentProfile, keyof typeof PROFILE_FIELDS>>;

export function upsertProfile(workspaceId: string, sessionId: string, patch: ProfilePatch) {
  const now = new Date().toISOString();
  db.query(
    `INSERT INTO agent_profiles (workspace_id, session_id, updated_at) VALUES (?, ?, ?)
     ON CONFLICT (session_id) DO NOTHING`,
  ).run(workspaceId, sessionId, now);
  const entries = Object.entries(patch).filter(
    (entry): entry is [keyof typeof PROFILE_FIELDS, string | number | null] =>
      entry[0] in PROFILE_FIELDS && entry[1] !== undefined,
  );
  for (const [key, value] of entries) {
    db.query(
      `UPDATE agent_profiles SET ${PROFILE_FIELDS[key]} = ?, updated_at = ? WHERE session_id = ?`,
    ).run(value, now, sessionId);
  }
  return getProfile(sessionId)!;
}

const USAGE_WEIGHTS: Record<string, number> = { open: 1, send: 3 };
const HALF_LIFE_MS = 3 * 24 * 60 * 60 * 1000;

export function recordUsage(workspaceId: string, sessionId: string, kind: string) {
  if (!(kind in USAGE_WEIGHTS)) return;
  db.query("INSERT INTO usage_events (workspace_id, session_id, kind, at) VALUES (?, ?, ?, ?)").run(
    workspaceId,
    sessionId,
    kind,
    Date.now(),
  );
}

/** Frecency: every open and message counts, halving in weight every three days. */
export function usageSummary(workspaceId: string): UsageSummary[] {
  const since = Date.now() - 60 * 24 * 60 * 60 * 1000;
  const rows = db
    .query<{ session_id: string; kind: string; at: number }, [string, number]>(
      "SELECT session_id, kind, at FROM usage_events WHERE workspace_id = ? AND at > ?",
    )
    .all(workspaceId, since);
  const now = Date.now();
  const summary = new Map<string, { score: number; last: number }>();
  for (const row of rows) {
    const entry = summary.get(row.session_id) ?? { score: 0, last: 0 };
    entry.score += (USAGE_WEIGHTS[row.kind] ?? 0) * Math.pow(0.5, (now - row.at) / HALF_LIFE_MS);
    entry.last = Math.max(entry.last, row.at);
    summary.set(row.session_id, entry);
  }
  return [...summary].map(([sessionId, entry]) => ({
    sessionId,
    score: Math.round(entry.score * 1000) / 1000,
    lastUsedAt: entry.last ? new Date(entry.last).toISOString() : null,
  }));
}

export type AppliedBlock = {
  key: string;
  kind: string;
  state: string;
  result: unknown;
};

export function getAppliedBlock(key: string): AppliedBlock | null {
  const row = db
    .query<{ block_key: string; kind: string; state: string; result: string | null }, [string]>(
      "SELECT block_key, kind, state, result FROM applied_blocks WHERE block_key = ?",
    )
    .get(key);
  return row
    ? {
        key: row.block_key,
        kind: row.kind,
        state: row.state,
        result: row.result ? JSON.parse(row.result) : null,
      }
    : null;
}

/** A claim this old belongs to a server that stopped mid-apply. */
const STALE_CLAIM_MS = 2 * 60 * 1000;

/**
 * Claims a block once. Returns the claim's owner token, or null when someone
 * else holds a live claim or the block is already applied.
 */
export function claimBlock(key: string, workspaceId: string, kind: string): string | null {
  const now = new Date();
  const owner = crypto.randomUUID();
  const result = db
    .query(
      `INSERT INTO applied_blocks (block_key, workspace_id, kind, state, created_at, owner)
       VALUES (?, ?, ?, 'applying', ?, ?)
       ON CONFLICT (block_key) DO UPDATE SET created_at = excluded.created_at, owner = excluded.owner
       WHERE applied_blocks.state = 'applying' AND applied_blocks.created_at < ?`,
    )
    .run(
      key,
      workspaceId,
      kind,
      now.toISOString(),
      owner,
      new Date(now.getTime() - STALE_CLAIM_MS).toISOString(),
    );
  return result.changes === 1 ? owner : null;
}

/** Settles a claim; a claim taken over in the meantime is left alone. */
export function settleBlock(key: string, owner: string, result: unknown) {
  db.query(
    "UPDATE applied_blocks SET state = 'applied', result = ? WHERE block_key = ? AND owner = ? AND state = 'applying'",
  ).run(JSON.stringify(result ?? null), key, owner);
}

export function releaseBlock(key: string, owner: string) {
  db.query(
    "DELETE FROM applied_blocks WHERE block_key = ? AND owner = ? AND state = 'applying'",
  ).run(key, owner);
}

export function getPrefs(workspaceId: string): Record<string, string> {
  const rows = db
    .query<{ key: string; value: string }, [string]>(
      "SELECT key, value FROM prefs WHERE workspace_id = ?",
    )
    .all(workspaceId);
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export function setPrefs(workspaceId: string, values: Record<string, string | null>) {
  for (const [key, value] of Object.entries(values)) {
    if (value === null) {
      db.query("DELETE FROM prefs WHERE workspace_id = ? AND key = ?").run(workspaceId, key);
    } else {
      db.query(
        `INSERT INTO prefs (workspace_id, key, value) VALUES (?, ?, ?)
         ON CONFLICT (workspace_id, key) DO UPDATE SET value = excluded.value`,
      ).run(workspaceId, key, value);
    }
  }
  return getPrefs(workspaceId);
}
