import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";

import {
  createDb,
  createPreferenceRegistryProposal,
  listCompanyBrainPreferenceGuidance,
  type DbClient,
} from "../src";

let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let accountId: string;
let workspaceId: string;

const subjectA = "company-brain-subject-a";
const subjectB = "company-brain-subject-b";

async function createProposal(input: {
  actorSubjectId: string;
  stableKey: string;
  scope: "organization" | "workspace" | "user";
  content: string;
}) {
  return await createPreferenceRegistryProposal(client!.db, {
    accountId,
    workspaceId,
    actorSubjectId: input.actorSubjectId,
    principalKind: "human_session",
    scope: input.scope,
    stableKey: input.stableKey,
    title: input.stableKey,
    description: `${input.stableKey} description`,
    content: input.content,
    precedenceRank: 0,
    conflictStrategy: "override",
    conflictsWith: [],
    provenanceSource: "human",
    provenanceSourceId: null,
    expiresAt: null,
  });
}

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("company-brain-preference-guidance");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1") {
      throw new Error("real PostgreSQL is required for Company Brain RLS proof");
    }
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
  const [account] = await shared.admin<{ id: string }[]>`
    insert into managed_accounts (name) values ('Company Brain guidance account') returning id
  `;
  accountId = account!.id;
  const [workspace] = await shared.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${accountId}, 'Company Brain guidance workspace') returning id
  `;
  workspaceId = workspace!.id;

  await createProposal({
    actorSubjectId: subjectA,
    stableKey: "organization-guide",
    scope: "organization",
    content: "ORGANIZATION_GUIDE_BODY",
  });
  await createProposal({
    actorSubjectId: subjectA,
    stableKey: "workspace-guide",
    scope: "workspace",
    content: "WORKSPACE_GUIDE_BODY",
  });
  await createProposal({
    actorSubjectId: subjectA,
    stableKey: "personal-guide-a",
    scope: "user",
    content: "SUBJECT_A_PRIVATE_BODY",
  });
  await createProposal({
    actorSubjectId: subjectB,
    stableKey: "personal-guide-b",
    scope: "user",
    content: "SUBJECT_B_PRIVATE_BODY",
  });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 60_000);

describe("Company Brain preference guidance (real PostgreSQL + FORCE RLS)", () => {
  test("returns shared guidance and only the exact subject's personal bodies", async () => {
    if (!shared || !client) return;
    const [preferencesPosture, revisionsPosture] = await shared.admin<
      Array<{ rowSecurity: boolean; forceRowSecurity: boolean }>
    >`
      select relrowsecurity as "rowSecurity", relforcerowsecurity as "forceRowSecurity"
      from pg_class
      where oid in (
        'preference_registry_preferences'::regclass,
        'preference_registry_revisions'::regclass
      )
      order by oid
    `;
    expect(preferencesPosture).toEqual({ rowSecurity: true, forceRowSecurity: true });
    expect(revisionsPosture).toEqual({ rowSecurity: true, forceRowSecurity: true });

    const forA = await listCompanyBrainPreferenceGuidance(client.db, {
      workspaceId,
      subjectId: subjectA,
    });
    const forB = await listCompanyBrainPreferenceGuidance(client.db, {
      workspaceId,
      subjectId: subjectB,
    });
    const contentA = forA.rows.map((row) => row.content).sort();
    const contentB = forB.rows.map((row) => row.content).sort();

    expect(contentA).toEqual([
      "ORGANIZATION_GUIDE_BODY",
      "SUBJECT_A_PRIVATE_BODY",
      "WORKSPACE_GUIDE_BODY",
    ]);
    expect(contentB).toEqual([
      "ORGANIZATION_GUIDE_BODY",
      "SUBJECT_B_PRIVATE_BODY",
      "WORKSPACE_GUIDE_BODY",
    ]);
    expect(JSON.stringify(forA)).not.toContain("SUBJECT_B_PRIVATE_BODY");
    expect(JSON.stringify(forB)).not.toContain("SUBJECT_A_PRIVATE_BODY");
    expect(JSON.stringify(forA)).not.toContain(subjectA);
    expect(JSON.stringify(forA)).not.toContain(subjectB);
    expect(JSON.stringify(forB)).not.toContain(subjectA);
    expect(JSON.stringify(forB)).not.toContain(subjectB);
  });
});
