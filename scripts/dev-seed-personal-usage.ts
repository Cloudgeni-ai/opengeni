#!/usr/bin/env bun
/**
 * Add usage to the other members' Personal workspaces in the design-preview
 * organization, so Organization settings > Billing & usage shows Personal rows.
 *
 *   bun scripts/dev-seed-personal-usage.ts --yes [--owner bendik@acme.dev]
 *
 * Runs after scripts/dev-seed-design-preview.ts, which creates the people and
 * seeds the owner's own Personal workspace. This file writes only
 * sessionless `usage_events` (model spend and tokens, agent runs, warm sandbox
 * time) for the last 30 days: no sessions, no content, nothing a model reads.
 *
 * Safety: requires --yes and this worktree's loopback migrations DSN from
 * `.env.runtime`. Idempotent: every row has a deterministic idempotency key,
 * so a rerun adds nothing.
 */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { SQL } from "bun";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const option = (name: string) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
function fail(message: string): never {
  console.error(`dev-seed-personal-usage: ${message}`);
  process.exit(1);
}
if (!args.includes("--yes")) fail("refusing to run without --yes (writes fake usage).");

const runtime = Object.fromEntries(
  readFileSync(resolve(repositoryRoot, ".env.runtime"), "utf8")
    .split("\n")
    .filter((line) => line.includes("=") && !line.trimStart().startsWith("#"))
    .map((line) => [line.slice(0, line.indexOf("=")).trim(), line.slice(line.indexOf("=") + 1)]),
);
const url = runtime.OPENGENI_MIGRATIONS_DATABASE_URL;
if (!url) fail("no OPENGENI_MIGRATIONS_DATABASE_URL in .env.runtime; start `bun run dev` first.");
if (!["127.0.0.1", "localhost", "[::1]", "::1"].includes(new URL(url).hostname)) {
  fail("the worktree database URL is not loopback.");
}
const ownerEmail = option("--owner") ?? "bendik@acme.dev";

// How busy each person's Personal workspace is, relative to one another.
const WEIGHTS = [1.4, 0.9, 0.55, 0.3, 0.15, 0.08];
const MODELS = [
  { model: "gpt-5.5", share: 0.6, costPerKToken: 0.0125 },
  { model: "claude-opus-5", share: 0.4, costPerKToken: 0.03 },
];

const db = new SQL(url);
try {
  const [owner] = await db`select id from auth_users where lower(email) = lower(${ownerEmail})`;
  if (!owner) fail(`no user ${ownerEmail}; run scripts/dev-seed-design-preview.ts first.`);
  const ownerSubject = `user:${owner.id}`;
  const [organization] = await db`select account_id from organization_memberships
    where subject_id = ${ownerSubject} and role = 'owner' and status = 'active'
    order by created_at limit 1`;
  if (!organization) fail(`${ownerEmail} owns no organization.`);
  const accountId = String(organization.account_id);
  const people = await db`select id, subject_id, personal_workspace_id from organization_memberships
    where account_id = ${accountId} and subject_id <> ${ownerSubject}
      and personal_workspace_id is not null
    order by created_at, id`;
  let inserted = 0;
  for (const [index, person] of people.entries()) {
    const weight = WEIGHTS[index % WEIGHTS.length]!;
    const workspaceId = String(person.personal_workspace_id);
    const subject = String(person.subject_id);
    let seed = [...String(person.id)].reduce((sum, char) => sum + char.charCodeAt(0), 0);
    const random = () => {
      seed = (seed * 9301 + 49297) % 233280;
      return seed / 233280;
    };
    await db.begin(async (tx) => {
      for (let day = 29; day >= 0; day--) {
        const weekday = new Date(Date.now() - day * 86_400_000).getUTCDay();
        const busy = weekday === 0 || weekday === 6 ? 0.3 : 1;
        const calls = Math.round((2 + random() * 6) * weight * busy);
        for (let call = 0; call < calls; call++) {
          const pick = random();
          const model = pick < MODELS[0]!.share ? MODELS[0]! : MODELS[1]!;
          const tokens = Math.round(6_000 + random() * 50_000);
          const cost = Math.round((tokens / 1000) * model.costPerKToken * 1_000_000 * 0.035);
          const occurredAt = new Date(
            Date.now() - day * 86_400_000 - Math.floor(random() * 10 * 3_600_000),
          );
          const key = `design-preview:personal-usage:${String(person.id)}:${day}:${call}`;
          const rows = [
            ["model.tokens", tokens, "tokens", "model", model.model],
            ["model.cost", cost, "usd_micros", "model", model.model],
            ...(call % 3 === 0
              ? [
                  ["agent_run.created", 1, "run", "session", key],
                  [
                    "sandbox.warm_seconds",
                    Math.round(90 + random() * 1200),
                    "seconds",
                    "sandbox",
                    key,
                  ],
                ]
              : []),
          ] as const;
          for (const [eventType, quantity, unit, sourceType, sourceId] of rows) {
            const result = await tx`insert into usage_events (account_id, workspace_id, subject_id,
                event_type, quantity, unit, source_resource_type, source_resource_id, idempotency_key,
                occurred_at, recorded_at, initiator_kind, initiator_subject_id, origin)
              values (${accountId}, ${workspaceId}, ${subject}, ${eventType}, ${quantity}, ${unit},
                ${sourceType}, ${sourceId}, ${`${key}:${eventType}`}, ${occurredAt}, ${occurredAt},
                'subject', ${subject}, 'user')
              on conflict (idempotency_key) do nothing`;
            inserted += result.count ?? 0;
          }
        }
      }
    });
  }
  console.log(
    `dev-seed-personal-usage: ${inserted} usage rows across ${people.length} Personal workspaces.`,
  );
} finally {
  await db.close();
}
