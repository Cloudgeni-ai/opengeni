import type { KnowledgeMemoryKind, WorkspaceMemoryPromptMode } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext } from "./database";
import { fromPostgresLosslessText } from "./lossless-json";
import {
  renderWorkspaceMemoryBlock,
  WORKSPACE_MEMORY_BLOCK_EMPTY,
  type MemoryBlockRecord,
} from "./memory-domain";

export type CompanyBrainContextAttemptClaims = Readonly<{
  accountId: string;
  workspaceId: string;
  sessionId: string;
  turnId: string;
  attemptId: string;
  executionGeneration: number;
}>;

export type CompanyBrainMemorySelectionReference = Readonly<{
  id: string;
  kind: KnowledgeMemoryKind;
  textHash: string;
  contentHash: string;
  textCodecVersion: number | null;
  memoryVersion: number;
  pinned: boolean;
}>;

export type CompanyBrainContextSelectionReceipt = Readonly<{
  id: string;
  rootSessionId: string;
  acceptedAt: string;
  sessionRole: "root" | "child";
  memoryEnabled: boolean;
  memoryPromptMode: WorkspaceMemoryPromptMode;
  companyProfileIncluded: boolean;
  instructionPolicyEntryHash: string;
  preferenceDescriptorHash: string | null;
  companyProfileSnapshotHash: string;
  selectionHash: string;
  selectedMemoryCount: number;
  visibleMemoryCount: number;
  omittedMemoryCount: number;
}>;

export type ResolvedCompanyBrainContextSelection = Readonly<{
  receipt: CompanyBrainContextSelectionReceipt;
  workspaceMemory: string | null;
}>;

type SelectionRow = {
  receipt_id: string;
  root_session_id: string;
  accepted_at: Date | string;
  session_role: string;
  memory_enabled: boolean;
  memory_prompt_mode: string;
  company_profile_included: boolean;
  instruction_policy_entry_hash: string;
  preference_descriptor_hash: string | null;
  company_profile_snapshot_hash: string;
  selection_hash: string;
  selected_memory_count: number;
  visible_memory_count: number;
  memory_id: string | null;
  memory_kind: string | null;
  memory_text: string | null;
  memory_text_codec_version: number | null;
  memory_pinned: boolean | null;
  selection_ordinal: number | null;
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function positiveGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Company Brain context selection requires a positive execution generation");
  }
}

/**
 * Freeze the broad legacy workspace-Memory candidate set once per accepted
 * logical turn. Recovery gets the original candidate identities and may only
 * lose rows that no longer pass current lifecycle/hash authorization. The
 * durable receipt contains references and hashes, never memory text.
 */
export async function resolveCompanyBrainContextSelection(
  db: Database,
  claims: CompanyBrainContextAttemptClaims,
): Promise<ResolvedCompanyBrainContextSelection> {
  positiveGeneration(claims.executionGeneration);
  const rows = await withRlsContext(
    db,
    { accountId: claims.accountId, workspaceId: claims.workspaceId },
    async (tx) =>
      await rawRows<SelectionRow>(
        tx,
        sql`SELECT * FROM company_brain_context_get_or_create_selection(
          ${claims.accountId}::uuid,
          ${claims.workspaceId}::uuid,
          ${claims.sessionId}::uuid,
          ${claims.turnId}::uuid,
          ${claims.attemptId}::uuid,
          ${claims.executionGeneration}::integer
        )`,
      ),
  );
  const first = rows[0];
  if (!first) throw new Error("Company Brain context selection returned no durable receipt");
  if (!Number.isSafeInteger(first.selected_memory_count) || first.selected_memory_count < 0) {
    throw new Error("Company Brain context selection returned an invalid selected count");
  }
  if (
    !Number.isSafeInteger(first.visible_memory_count) ||
    first.visible_memory_count < 0 ||
    first.visible_memory_count > first.selected_memory_count
  ) {
    throw new Error("Company Brain context selection returned an invalid visible count");
  }
  if (first.session_role !== "root" && first.session_role !== "child") {
    throw new Error("Company Brain context selection returned an invalid session role");
  }
  if (
    first.memory_prompt_mode !== "legacy_standing" &&
    first.memory_prompt_mode !== "retrieval_only"
  ) {
    throw new Error("Company Brain context selection returned an invalid memory prompt mode");
  }

  const memoryRecords: MemoryBlockRecord[] = rows.flatMap((row) => {
    if (
      row.memory_id === null ||
      row.memory_kind === null ||
      row.memory_text === null ||
      row.memory_pinned === null ||
      row.selection_ordinal === null
    ) {
      return [];
    }
    return [
      {
        id: row.memory_id,
        kind: row.memory_kind as KnowledgeMemoryKind,
        text: fromPostgresLosslessText(row.memory_text, row.memory_text_codec_version),
        pinned: row.memory_pinned,
      },
    ];
  });
  if (memoryRecords.length !== first.visible_memory_count) {
    throw new Error("Company Brain context selection returned an incomplete visible projection");
  }
  const workspaceMemory =
    !first.memory_enabled || first.memory_prompt_mode === "retrieval_only"
      ? null
      : (renderWorkspaceMemoryBlock(memoryRecords) ?? WORKSPACE_MEMORY_BLOCK_EMPTY);

  return {
    receipt: {
      id: first.receipt_id,
      rootSessionId: first.root_session_id,
      acceptedAt: iso(first.accepted_at),
      sessionRole: first.session_role,
      memoryEnabled: first.memory_enabled,
      memoryPromptMode: first.memory_prompt_mode,
      companyProfileIncluded: first.company_profile_included,
      instructionPolicyEntryHash: first.instruction_policy_entry_hash,
      preferenceDescriptorHash: first.preference_descriptor_hash,
      companyProfileSnapshotHash: first.company_profile_snapshot_hash,
      selectionHash: first.selection_hash,
      selectedMemoryCount: first.selected_memory_count,
      visibleMemoryCount: first.visible_memory_count,
      omittedMemoryCount: first.selected_memory_count - first.visible_memory_count,
    },
    workspaceMemory,
  };
}
