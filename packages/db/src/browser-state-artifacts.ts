import {
  BrowserRevisionMaterialization,
  type BrowserRevisionMaterialization as BrowserRevisionMaterializationValue,
} from "@opengeni/contracts";
import { and, eq, sql } from "drizzle-orm";
import { type Database, rawRows, withRlsContext } from "./database";
import * as schema from "./schema";

type BrowserStateArtifactRow = typeof schema.browserStateArtifacts.$inferSelect;

const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const OBJECT_KEY_SEGMENT_PATTERN = /^[A-Za-z0-9._=-]+$/u;

export type BrowserStateArtifactCommitInput = {
  kind: BrowserStateArtifactRow["kind"];
  format: string;
  artifactDigest: string;
  contentDigest: string;
  manifestDigest: string;
  objectKey: string;
  encryptedDataKey: string;
  sizeBytes: number;
  materialization: BrowserRevisionMaterializationValue;
};

export type BrowserStateArtifactCleanupClaim = {
  claimId: string;
  artifactId: string;
  accountId: string;
  workspaceId: string;
  objectKey: string;
};

/** Validate storage authority before it can become durable state. */
export function validateBrowserStateArtifactCommitInput(
  workspaceId: string,
  value: BrowserStateArtifactCommitInput,
): BrowserStateArtifactCommitInput {
  const prefix = `workspaces/${workspaceId}/browser-state/`;
  const objectKeySuffix = value.objectKey.slice(prefix.length);
  if (
    !SHA256_PATTERN.test(value.artifactDigest) ||
    !SHA256_PATTERN.test(value.contentDigest) ||
    !SHA256_PATTERN.test(value.manifestDigest) ||
    !value.objectKey.startsWith(prefix) ||
    objectKeySuffix.length < 1 ||
    objectKeySuffix
      .split("/")
      .some(
        (segment) =>
          !OBJECT_KEY_SEGMENT_PATTERN.test(segment) || segment === "." || segment === "..",
      ) ||
    Buffer.byteLength(value.objectKey) > 2_048 ||
    value.format.trim() !== value.format ||
    Buffer.byteLength(value.format) < 1 ||
    Buffer.byteLength(value.format) > 512 ||
    Buffer.byteLength(value.encryptedDataKey) < 16 ||
    Buffer.byteLength(value.encryptedDataKey) > 8_192 ||
    !Number.isSafeInteger(value.sizeBytes) ||
    value.sizeBytes < 1
  ) {
    throw new Error("Browser state artifact metadata is invalid");
  }
  const materialization = BrowserRevisionMaterialization.parse(value.materialization);
  if (value.kind === "provider_snapshot" && materialization.portability !== "provider_bound") {
    throw new Error("Provider snapshots must declare their provider binding");
  }
  return { ...value, materialization };
}

/**
 * Claim a bounded cross-workspace batch of retired private checkpoints. The
 * privileged SQL function is the only FORCE-RLS bypass; stale claims are
 * reclaimable and published revision components are structurally ineligible.
 */
export async function claimBrowserStateArtifactCleanup(
  db: Database,
  input: { claimTimeoutMs: number; limit: number },
): Promise<BrowserStateArtifactCleanupClaim[]> {
  const rows = await rawRows<{
    claim_id: string;
    artifact_id: string;
    account_id: string;
    workspace_id: string;
    object_key: string;
  }>(
    db,
    sql`
      select claim_id, artifact_id, account_id, workspace_id, object_key
      from opengeni_private.claim_browser_state_artifact_cleanup(
        ${input.claimTimeoutMs},
        ${input.limit}
      )
    `,
  );
  return rows.map((row) => ({
    claimId: row.claim_id,
    artifactId: row.artifact_id,
    accountId: row.account_id,
    workspaceId: row.workspace_id,
    objectKey: row.object_key,
  }));
}

/**
 * Settle one exact claim only after its provider object was deleted. Completion
 * is idempotent after a lost response and erases the wrapped data key.
 */
export async function completeBrowserStateArtifactCleanup(
  db: Database,
  input: BrowserStateArtifactCleanupClaim,
): Promise<boolean> {
  return await withRlsContext(
    db,
    { accountId: input.accountId, workspaceId: input.workspaceId },
    async (scopedDb) =>
      await scopedDb.transaction(async (tx) => {
        const [artifact] = await tx
          .select({
            state: schema.browserStateArtifacts.state,
            deleteClaimId: schema.browserStateArtifacts.deleteClaimId,
          })
          .from(schema.browserStateArtifacts)
          .where(
            and(
              eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
              eq(schema.browserStateArtifacts.id, input.artifactId),
              eq(schema.browserStateArtifacts.purpose, "private_checkpoint"),
              eq(schema.browserStateArtifacts.objectKey, input.objectKey),
            ),
          )
          .for("update")
          .limit(1);
        if (!artifact) return false;
        if (artifact.state === "deleted") return true;
        if (artifact.state !== "deleting" || artifact.deleteClaimId !== input.claimId) {
          return false;
        }
        const [settled] = await tx
          .update(schema.browserStateArtifacts)
          .set({
            state: "deleted",
            encryptedDataKey: null,
            deleteClaimId: null,
            deleteClaimedAt: null,
            deletedAt: new Date(),
          })
          .where(
            and(
              eq(schema.browserStateArtifacts.workspaceId, input.workspaceId),
              eq(schema.browserStateArtifacts.id, input.artifactId),
              eq(schema.browserStateArtifacts.state, "deleting"),
              eq(schema.browserStateArtifacts.deleteClaimId, input.claimId),
            ),
          )
          .returning({ id: schema.browserStateArtifacts.id });
        return settled !== undefined;
      }),
  );
}
