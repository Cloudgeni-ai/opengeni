import { timingSafeEqual } from "node:crypto";
import {
  ClaudeSubscriptionCredential,
  emptyClaudeUsage,
  mergeClaudeUsage,
  type ClaudeUsageObservation,
} from "@opengeni/config";
import {
  ClaudeSubscriptionUsage,
  type ClaudeProviderAccountAuthoritySnapshotV1,
} from "@opengeni/contracts";
import { and, eq, inArray, sql } from "drizzle-orm";
import {
  type Database,
  setSubjectRlsContext,
  withRlsContext,
  withWorkspaceSubjectRls,
} from "./database";
import { decryptEnvironmentValue } from "./environment-crypto";
import {
  claudeSubscriptionAccountRepository,
  withOrganizationClaudeCapacityMutation,
} from "./claude-subscription-accounts";
import * as schema from "./schema";

export type ClaudeAccountUsageAuthority = {
  accountId: string;
  subjectId: string;
  credentialId: string;
} & (
  | { workspaceId: string; authoritySnapshot: ClaudeProviderAccountAuthoritySnapshotV1 }
  | { workspaceId: null; authoritySnapshot: { version: 1; scope: "organization" } }
);

function snapshot(
  row: typeof schema.claudeSubscriptionAccountUsage.$inferSelect | undefined,
  version: number,
) {
  const parsed =
    row?.credentialVersion === version ? ClaudeSubscriptionUsage.safeParse(row.snapshot) : null;
  return parsed?.success && parsed.data.credentialVersion === version
    ? parsed.data
    : emptyClaudeUsage(version);
}

/** Metadata-only bulk read: private accounts remain protected by the credential's own RLS. */
export async function listClaudeAccountUsage(
  db: Database,
  input: { accountId: string; subjectId: string; workspaceId: string | null },
  accounts: readonly { id: string; version: number }[],
) {
  const read = async (tx: Database) => {
    if (accounts.length === 0) return new Map<string, ClaudeSubscriptionUsage>();
    const rows = await tx
      .select()
      .from(schema.claudeSubscriptionAccountUsage)
      .where(
        and(
          eq(schema.claudeSubscriptionAccountUsage.accountId, input.accountId),
          inArray(
            schema.claudeSubscriptionAccountUsage.credentialId,
            accounts.map((account) => account.id),
          ),
        ),
      );
    const byId = new Map(rows.map((row) => [row.credentialId, row]));
    // Do not project an invisible credential as an unknown, connected account.
    const visible = await tx
      .select({
        id: schema.claudeSubscriptionCredentials.id,
        version: schema.claudeSubscriptionCredentials.version,
      })
      .from(schema.claudeSubscriptionCredentials)
      .where(
        and(
          eq(schema.claudeSubscriptionCredentials.accountId, input.accountId),
          inArray(
            schema.claudeSubscriptionCredentials.id,
            accounts.map((account) => account.id),
          ),
        ),
      );
    return new Map(
      visible.map((account) => [account.id, snapshot(byId.get(account.id), account.version)]),
    );
  };
  if (input.workspaceId)
    return withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, read);
  return withRlsContext(db, { accountId: input.accountId, workspaceId: null }, async (tx) => {
    await setSubjectRlsContext(tx, input.subjectId);
    await tx.execute(
      sql`select get_organization_administration_overview(${input.accountId}::uuid, ${input.subjectId})`,
    );
    return read(tx);
  });
}

/** Secret access requires live proof for this exact account, independently of list visibility. */
export async function loadClaudeAccountCredential(
  db: Database,
  authority: ClaudeAccountUsageAuthority,
  encryptionKey: Uint8Array,
) {
  const load = async (
    tx: Database,
    row: { id: string; accountId: string; version: number; credentialEncrypted: string },
  ) => {
    if (row.accountId !== authority.accountId) throw new Error("Claude account is unavailable");
    const [usage] = await tx
      .select()
      .from(schema.claudeSubscriptionAccountUsage)
      .where(eq(schema.claudeSubscriptionAccountUsage.credentialId, row.id));
    return {
      id: row.id,
      version: row.version,
      secret: ClaudeSubscriptionCredential.parse(
        JSON.parse(decryptEnvironmentValue(encryptionKey, row.credentialEncrypted)),
      ),
      usage: snapshot(usage, row.version),
      authoritySnapshot: authority.authoritySnapshot,
    };
  };
  if (authority.workspaceId)
    return claudeSubscriptionAccountRepository.withAuthorizedSubscriptionCredential(
      db,
      { ...authority, workspaceId: authority.workspaceId },
      load,
    );
  return withRlsContext(db, { accountId: authority.accountId, workspaceId: null }, async (tx) => {
    await setSubjectRlsContext(tx, authority.subjectId);
    await tx.execute(
      sql`select get_organization_administration_overview(${authority.accountId}::uuid, ${authority.subjectId})`,
    );
    const [row] = await tx
      .select()
      .from(schema.claudeSubscriptionCredentials)
      .where(
        and(
          eq(schema.claudeSubscriptionCredentials.accountId, authority.accountId),
          eq(schema.claudeSubscriptionCredentials.id, authority.credentialId),
          eq(schema.claudeSubscriptionCredentials.authorityScope, "organization"),
          eq(schema.claudeSubscriptionCredentials.status, "active"),
        ),
      )
      .limit(1);
    if (!row) throw new Error("Claude account is unavailable");
    return load(tx, row);
  });
}

/** A response receipt must match both the logical generation and the exact dispatched token. */
export async function recordClaudeAccountUsage(
  db: Database,
  authority: ClaudeAccountUsageAuthority,
  input: {
    encryptionKey: Uint8Array;
    expectedCredentialVersion: number;
    token: string;
    observation?: ClaudeUsageObservation;
    /** Local model backpressure deadline, separate from provider-reported quotas. */
    modelCooldown?: { upstreamModelId: string; until: Date };
    refresh?: { status: ClaudeSubscriptionUsage["refreshStatus"]; checkedAt: string };
  },
) {
  const record = async (
    tx: Database,
    credential: {
      id: string;
      accountId: string;
      version: number;
      credentialEncrypted: string;
    },
  ) => {
    if (
      credential.accountId !== authority.accountId ||
      credential.version !== input.expectedCredentialVersion
    )
      return null;
    const secret = ClaudeSubscriptionCredential.parse(
      JSON.parse(decryptEnvironmentValue(input.encryptionKey, credential.credentialEncrypted)),
    );
    const left = Buffer.from(secret.token),
      right = Buffer.from(input.token);
    if (left.length !== right.length || !timingSafeEqual(left, right)) return null;
    const [row] = await tx
      .select()
      .from(schema.claudeSubscriptionAccountUsage)
      .where(eq(schema.claudeSubscriptionAccountUsage.credentialId, credential.id));
    let next = snapshot(row, credential.version);
    const modelCooldowns: Record<string, string> = Object.create(null);
    const now = Date.now();
    if (row?.credentialVersion === credential.version) {
      for (const [model, until] of Object.entries(row.modelCooldowns))
        if (
          model.trim() &&
          model.length <= 256 &&
          Number.isFinite(Date.parse(until)) &&
          Date.parse(until) > now
        )
          modelCooldowns[model] = until;
    }
    if (input.modelCooldown) {
      const { upstreamModelId, until } = input.modelCooldown;
      if (
        !upstreamModelId.trim() ||
        upstreamModelId.length > 256 ||
        !Number.isFinite(until.getTime()) ||
        until.getTime() <= now
      )
        throw new Error("Invalid Claude model cooldown");
      const prior = modelCooldowns[upstreamModelId];
      modelCooldowns[upstreamModelId] = new Date(
        Math.max(prior ? Date.parse(prior) : 0, until.getTime()),
      ).toISOString();
    }
    if (Object.keys(modelCooldowns).length > 64) throw new Error("Too many Claude model cooldowns");
    if (input.observation) next = mergeClaudeUsage(next, input.observation);
    if (
      input.refresh &&
      (!next.refreshCheckedAt ||
        Date.parse(next.refreshCheckedAt) <= Date.parse(input.refresh.checkedAt))
    ) {
      next = {
        ...next,
        refreshStatus: input.refresh.status,
        refreshCheckedAt: input.refresh.checkedAt,
      };
    }
    next = ClaudeSubscriptionUsage.parse(next);
    await tx
      .insert(schema.claudeSubscriptionAccountUsage)
      .values({
        credentialId: credential.id,
        accountId: credential.accountId,
        credentialVersion: credential.version,
        snapshot: next,
        modelCooldowns: { ...modelCooldowns },
      })
      .onConflictDoUpdate({
        target: schema.claudeSubscriptionAccountUsage.credentialId,
        set: {
          credentialVersion: credential.version,
          snapshot: next,
          modelCooldowns: { ...modelCooldowns },
          updatedAt: new Date(),
        },
      });
    return next;
  };
  if (authority.workspaceId) {
    const result = await claudeSubscriptionAccountRepository.withAuthorizedSubscriptionCredential(
      db,
      {
        ...authority,
        workspaceId: authority.workspaceId,
        lock: true,
      },
      record,
    );
    // Release the credential lock before taking the allocation/waiter locks.
    if (result)
      await claudeSubscriptionAccountRepository.wakeSubscriptionCapacityWaiters(db, {
        workspaceId: authority.workspaceId,
        subjectId: authority.subjectId,
        authoritySnapshot: authority.authoritySnapshot,
        reason: "claude_quota_observed",
      });
    return result;
  }
  return withOrganizationClaudeCapacityMutation(
    db,
    {
      organizationId: authority.accountId,
      actorSubjectId: authority.subjectId,
    },
    async (tx) => {
      const [credential] = await tx
        .select()
        .from(schema.claudeSubscriptionCredentials)
        .where(
          and(
            eq(schema.claudeSubscriptionCredentials.accountId, authority.accountId),
            eq(schema.claudeSubscriptionCredentials.id, authority.credentialId),
            eq(schema.claudeSubscriptionCredentials.authorityScope, "organization"),
            eq(schema.claudeSubscriptionCredentials.status, "active"),
          ),
        )
        .for("update")
        .limit(1);
      return credential ? record(tx, credential) : null;
    },
  );
}
