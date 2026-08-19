import type { KnowledgeMemoryKind, HistoricalMemoryPromptMode } from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import type { Database } from "./database";
import { rawRows, withRlsContext, withWorkspaceSubjectRls } from "./database";
import { fromPostgresLosslessText } from "./lossless-json";
import { selectWorkspaceMemoryBlockRecords, type MemoryBlockRecord } from "./memory-domain";

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
  memoryPromptMode: HistoricalMemoryPromptMode;
  companyProfileIncluded: boolean;
  instructionPolicyEntryHash: string;
  preferenceDescriptorHash: string | null;
  companyProfileSnapshotHash: string;
  turnContextSnapshotId: string;
  turnContextSnapshotHash: string;
  turnContextSnapshotSource: "accepted_turn" | "legacy_first_claim";
  legacyWorkspaceInstructionsOriginalUtf8Bytes: number | null;
  legacyWorkspaceInstructionsTruncated: boolean;
  selectionHash: string;
  selectedMemoryCount: number;
  renderedMemoryCount: number;
  visibleMemoryCount: number;
  budgetOmittedMemoryCount: number;
  authorizationOmittedMemoryCount: number;
  omittedMemoryCount: number;
}>;

export type ResolvedCompanyBrainContextSelection = Readonly<{
  receipt: CompanyBrainContextSelectionReceipt;
  legacyWorkspaceInstructions: string | null;
  workspaceMemory: string | null;
}>;

export type CompanyBrainContextReceiptInspection = Readonly<{
  id: string;
  sessionId: string;
  rootSessionId: string;
  turnId: string;
  acceptedAt: string;
  createdAt: string;
  sessionRole: "root" | "child";
  memoryEnabled: boolean;
  memoryPromptMode: HistoricalMemoryPromptMode;
  companyProfileIncluded: boolean;
  instructionPolicyEntryHash: string;
  preferenceDescriptorHash: string | null;
  companyProfileSnapshotHash: string;
  turnContextSnapshotId: string;
  turnContextSnapshotHash: string;
  turnContextSnapshotSource: "accepted_turn" | "legacy_first_claim";
  selectionHash: string;
  selectedMemoryCount: number;
  renderedMemoryCount: number;
  budgetOmittedMemoryCount: number;
}>;

export type CompanyBrainContextReceiptInspectionCursor = Readonly<{
  createdAt: string;
  id: string;
}>;

export type InspectCompanyBrainContextReceiptsInput = Readonly<{
  workspaceId: string;
  subjectId: string;
  attemptId?: string;
  before?: CompanyBrainContextReceiptInspectionCursor;
  limit?: number;
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
  turn_context_snapshot_id: string;
  turn_context_snapshot_hash: string;
  turn_context_snapshot_source: string;
  legacy_workspace_instructions: string | null;
  legacy_workspace_instructions_original_utf8_bytes: number | null;
  legacy_workspace_instructions_truncated: boolean;
  selection_hash: string;
  selected_memory_count: number;
  rendered_memory_count: number;
  visible_memory_count: number;
  memory_id: string | null;
  memory_kind: string | null;
  memory_text: string | null;
  memory_text_codec_version: number | null;
  memory_pinned: boolean | null;
  selection_ordinal: number | null;
};

type InspectionRow = {
  receipt_id: string;
  session_id: string;
  root_session_id: string;
  turn_id: string;
  accepted_at: Date | string;
  created_at: Date | string;
  session_role: string;
  memory_enabled: boolean;
  memory_prompt_mode: string;
  company_profile_included: boolean;
  instruction_policy_entry_hash: string;
  preference_descriptor_hash: string | null;
  company_profile_snapshot_hash: string;
  turn_context_snapshot_id: string;
  turn_context_snapshot_hash: string;
  turn_context_snapshot_source: string;
  selection_hash: string;
  selected_memory_count: number;
  rendered_memory_count: number;
};

function iso(value: Date | string): string {
  return (value instanceof Date ? value : new Date(value)).toISOString();
}

function positiveGeneration(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("Company Brain context selection requires a positive execution generation");
  }
}

function inspectionLimit(value: number | undefined): number {
  const resolved = value ?? 20;
  if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > 51) {
    throw new Error("Company Brain context receipt inspection limit must be between 1 and 51");
  }
  return resolved;
}

function inspectionReceipt(row: InspectionRow): CompanyBrainContextReceiptInspection {
  if (row.session_role !== "root" && row.session_role !== "child") {
    throw new Error("Company Brain receipt inspection returned an invalid session role");
  }
  if (row.memory_prompt_mode !== "legacy_standing" && row.memory_prompt_mode !== "retrieval_only") {
    throw new Error("Company Brain receipt inspection returned an invalid memory prompt mode");
  }
  if (
    row.turn_context_snapshot_source !== "accepted_turn" &&
    row.turn_context_snapshot_source !== "legacy_first_claim"
  ) {
    throw new Error("Company Brain receipt inspection returned an invalid snapshot source");
  }
  if (
    !Number.isSafeInteger(row.selected_memory_count) ||
    row.selected_memory_count < 0 ||
    !Number.isSafeInteger(row.rendered_memory_count) ||
    row.rendered_memory_count < 0 ||
    row.rendered_memory_count > row.selected_memory_count
  ) {
    throw new Error("Company Brain receipt inspection returned invalid selection counts");
  }
  return {
    id: row.receipt_id,
    sessionId: row.session_id,
    rootSessionId: row.root_session_id,
    turnId: row.turn_id,
    acceptedAt: iso(row.accepted_at),
    createdAt: iso(row.created_at),
    sessionRole: row.session_role,
    memoryEnabled: row.memory_enabled,
    memoryPromptMode: row.memory_prompt_mode,
    companyProfileIncluded: row.company_profile_included,
    instructionPolicyEntryHash: row.instruction_policy_entry_hash,
    preferenceDescriptorHash: row.preference_descriptor_hash,
    companyProfileSnapshotHash: row.company_profile_snapshot_hash,
    turnContextSnapshotId: row.turn_context_snapshot_id,
    turnContextSnapshotHash: row.turn_context_snapshot_hash,
    turnContextSnapshotSource: row.turn_context_snapshot_source,
    selectionHash: row.selection_hash,
    selectedMemoryCount: row.selected_memory_count,
    renderedMemoryCount: row.rendered_memory_count,
    budgetOmittedMemoryCount: row.selected_memory_count - row.rendered_memory_count,
  };
}

/**
 * Read a bounded, content-free projection of existing accepted-turn receipts.
 * The SQL capability independently proves the exact human and both session
 * references; this adapter never calls the receipt-creating worker function.
 */
export async function inspectCompanyBrainContextReceipts(
  db: Database,
  input: InspectCompanyBrainContextReceiptsInput,
): Promise<readonly CompanyBrainContextReceiptInspection[]> {
  const limit = inspectionLimit(input.limit);
  return await withWorkspaceSubjectRls(db, input.workspaceId, input.subjectId, async (tx) => {
    const rows = await rawRows<InspectionRow>(
      tx,
      sql`SELECT * FROM company_brain_inspect_context_receipts(
        current_setting('opengeni.account_id')::uuid,
        ${input.workspaceId}::uuid,
        ${input.subjectId}::text,
        ${input.attemptId ?? null}::uuid,
        ${input.before?.createdAt ?? null}::timestamptz,
        ${input.before?.id ?? null}::uuid,
        ${limit}::integer
      )`,
    );
    return rows.map(inspectionReceipt);
  });
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
    !Number.isSafeInteger(first.rendered_memory_count) ||
    first.rendered_memory_count < 0 ||
    first.rendered_memory_count > first.selected_memory_count
  ) {
    throw new Error("Company Brain context selection returned an invalid rendered count");
  }
  if (
    !Number.isSafeInteger(first.visible_memory_count) ||
    first.visible_memory_count < 0 ||
    first.visible_memory_count > first.rendered_memory_count
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
  if (
    first.turn_context_snapshot_source !== "accepted_turn" &&
    first.turn_context_snapshot_source !== "legacy_first_claim"
  ) {
    throw new Error("Company Brain context selection returned an invalid turn snapshot source");
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
  if (selectWorkspaceMemoryBlockRecords(memoryRecords).length !== memoryRecords.length) {
    throw new Error("Company Brain context selection exceeded its frozen prompt budget");
  }
  // Memory V1's standing block is retired. Retrieval-only composition is the
  // only mode, so nothing is injected into the prompt: an agent reads the
  // workspace's records through `memory_search` when it needs them, rather
  // than receiving them unbidden on every turn. Historical receipts keep the
  // mode they recorded; this is about what gets composed now.
  const workspaceMemory = null;

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
      turnContextSnapshotId: first.turn_context_snapshot_id,
      turnContextSnapshotHash: first.turn_context_snapshot_hash,
      turnContextSnapshotSource: first.turn_context_snapshot_source,
      legacyWorkspaceInstructionsOriginalUtf8Bytes:
        first.legacy_workspace_instructions_original_utf8_bytes,
      legacyWorkspaceInstructionsTruncated: first.legacy_workspace_instructions_truncated,
      selectionHash: first.selection_hash,
      selectedMemoryCount: first.selected_memory_count,
      renderedMemoryCount: first.rendered_memory_count,
      visibleMemoryCount: first.visible_memory_count,
      budgetOmittedMemoryCount: first.selected_memory_count - first.rendered_memory_count,
      authorizationOmittedMemoryCount: first.rendered_memory_count - first.visible_memory_count,
      omittedMemoryCount: first.selected_memory_count - first.visible_memory_count,
    },
    legacyWorkspaceInstructions: first.legacy_workspace_instructions,
    workspaceMemory,
  };
}
