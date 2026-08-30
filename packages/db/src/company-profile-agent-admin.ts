import { createHash } from "node:crypto";
import {
  CompanyProfileAgentAttempt,
  CompanyProfileAgentConfirmRequest,
  CompanyProfileAgentConfirmationReceipt,
  CompanyProfileAgentHumanInputPrompt,
  CompanyProfileAgentProposalReceipt,
  CompanyProfileAgentProposalRequest,
  CompanyProfileContent,
  type CompanyProfileAgentAttempt as CompanyProfileAgentAttemptType,
  type CompanyProfileAgentConfirmRequest as CompanyProfileAgentConfirmRequestType,
  type CompanyProfileAgentConfirmationReceipt as CompanyProfileAgentConfirmationReceiptType,
  type CompanyProfileAgentProposalReceipt as CompanyProfileAgentProposalReceiptType,
  type CompanyProfileAgentProposalRequest as CompanyProfileAgentProposalRequestType,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, withSessionRlsActorContext, type Database } from "./database";
import {
  getCompanyProfileActivationEvent,
  getCompanyProfileRevision,
  listCompanyProfile,
} from "./company-profile";
import { nestedPostgresSqlState } from "./persistence-errors";

export class CompanyProfileAgentAdminError extends Error {
  readonly name = "CompanyProfileAgentAdminError";

  constructor(
    readonly code:
      | "authority_unavailable"
      | "policy_disabled"
      | "confirmation_unavailable"
      | "profile_conflict"
      | "operation_reused"
      | "invalid_operation",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function canonicalProfileJson(value: unknown): string {
  const profile = CompanyProfileContent.parse(value);
  return JSON.stringify({
    identity: profile.identity,
    mission: profile.mission,
    products: profile.products.map(({ key, content }) => ({ key, content })),
    customers: profile.customers.map(({ key, content }) => ({ key, content })),
    goals: profile.goals.map(({ key, content }) => ({ key, content })),
    constraints: profile.constraints.map(({ key, content }) => ({ key, content })),
  });
}

function translate(error: unknown, stage: "propose" | "confirm"): never {
  const state = nestedPostgresSqlState(error);
  if (state === "42501") {
    throw new CompanyProfileAgentAdminError(
      stage === "confirm" ? "confirmation_unavailable" : "authority_unavailable",
      stage === "confirm"
        ? "The bound organization-owner confirmation is unavailable or no longer valid."
        : "An exact live turn initiated by the active organization owner is required.",
      { cause: error },
    );
  }
  if (state === "P1852") {
    throw new CompanyProfileAgentAdminError(
      "policy_disabled",
      "Agent-authored company-profile changes are disabled by organization policy.",
      { cause: error },
    );
  }
  if (state === "40001") {
    throw new CompanyProfileAgentAdminError(
      "profile_conflict",
      "The organization company profile changed after this proposal was prepared. Create a new proposal against the current profile.",
      { cause: error },
    );
  }
  if (state === "P1851" || state === "23505") {
    throw new CompanyProfileAgentAdminError(
      "operation_reused",
      "The company-profile operation id was already used for different input.",
      { cause: error },
    );
  }
  if (state === "22023" || state === "23514" || state === "55000") {
    throw new CompanyProfileAgentAdminError(
      "invalid_operation",
      "The company-profile administration request is invalid or no longer eligible.",
      { cause: error },
    );
  }
  throw error;
}

/** Deterministic UUID-shaped id for the activation stage of one proposal operation. */
export function derivedCompanyProfileAutomaticActivationOperationId(operationId: string): string {
  const bytes = createHash("sha256")
    .update(`company-profile-agent-admin:v1:${operationId}:automatic-activation`, "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function withAgentAttemptContext<T>(
  db: Database,
  attempt: CompanyProfileAgentAttemptType,
  fn: (scoped: Database) => Promise<T>,
): Promise<T> {
  return await withSessionRlsActorContext({ subjectId: attempt.agentSubjectId }, async () =>
    withRlsContext(
      db,
      { accountId: attempt.accountId, workspaceId: attempt.workspaceId },
      async (scoped) => {
        await scoped.execute(
          sql`select set_config('opengeni.principal_kind', 'agent_attempt', true)`,
        );
        return await fn(scoped);
      },
    ),
  );
}

export async function proposeCompanyProfileForAgent(
  db: Database,
  raw: { attempt: CompanyProfileAgentAttemptType; request: CompanyProfileAgentProposalRequestType },
): Promise<CompanyProfileAgentProposalReceiptType> {
  const attempt = CompanyProfileAgentAttempt.parse(raw.attempt);
  const request = CompanyProfileAgentProposalRequest.parse(raw.request);
  const contentJson = canonicalProfileJson(request.profile);
  const contentHash = createHash("sha256").update(contentJson, "utf8").digest("hex");
  try {
    const result = await withAgentAttemptContext(db, attempt, async (scoped) => {
      const [row] = await rawRows<{
        receipt_id: string;
        revision_id: string;
        human_input: unknown;
        policy_mode: "suggest" | "automatic";
        automatic_activation_receipt_id: string | null;
        activation_event_id: string | null;
        replayed: boolean;
      }>(
        scoped,
        sql`select * from propose_company_profile_for_attempt_v2(
          ${attempt.accountId}::uuid,
          ${attempt.workspaceId}::uuid,
          ${attempt.sessionId}::uuid,
          ${attempt.turnId}::uuid,
          ${attempt.attemptId}::uuid,
          ${attempt.executionGeneration},
          ${request.operationId}::uuid,
          ${derivedCompanyProfileAutomaticActivationOperationId(request.operationId)}::uuid,
          ${contentJson},
          ${contentHash},
          ${request.reason}
        )`,
      );
      if (!row) throw new Error("Company-profile proposal returned no receipt");
      return row;
    });
    if (
      result.policy_mode === "automatic" &&
      result.automatic_activation_receipt_id &&
      result.activation_event_id
    ) {
      const [inventory, event] = await Promise.all([
        listCompanyProfile(db, {
          accountId: attempt.accountId,
          workspaceId: attempt.workspaceId,
          limit: 1,
        }),
        getCompanyProfileActivationEvent(db, {
          accountId: attempt.accountId,
          workspaceId: attempt.workspaceId,
          eventId: result.activation_event_id,
        }),
      ]);
      if (!event?.newRevision) {
        throw new Error("Company-profile automatic activation event is unavailable");
      }
      const revision = await getCompanyProfileRevision(db, {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        revisionId: event.newRevision.id,
      });
      return CompanyProfileAgentProposalReceipt.parse({
        status: "activated",
        operationId: request.operationId,
        proposalReceiptId: result.receipt_id,
        automaticActivationReceiptId: result.automatic_activation_receipt_id,
        policyMode: "automatic",
        mutation: {
          revision,
          head: inventory.current?.revisionId === revision.id ? inventory.current : null,
          event,
        },
        replayed: result.replayed,
      });
    }
    if (result.policy_mode !== "suggest") {
      throw new Error("Company-profile proposal returned an incomplete automatic activation");
    }
    const revision = await getCompanyProfileRevision(db, {
      accountId: attempt.accountId,
      workspaceId: attempt.workspaceId,
      revisionId: result.revision_id,
    });
    return CompanyProfileAgentProposalReceipt.parse({
      status: "confirmation_required",
      operationId: request.operationId,
      proposalReceiptId: result.receipt_id,
      revision,
      policyMode: "suggest",
      humanInput: CompanyProfileAgentHumanInputPrompt.parse(result.human_input),
      confirmWith: "company_profile_confirm",
      replayed: result.replayed,
    });
  } catch (error) {
    translate(error, "propose");
  }
}

export async function confirmCompanyProfileForAgent(
  db: Database,
  raw: { attempt: CompanyProfileAgentAttemptType; request: CompanyProfileAgentConfirmRequestType },
): Promise<CompanyProfileAgentConfirmationReceiptType> {
  const attempt = CompanyProfileAgentAttempt.parse(raw.attempt);
  const request = CompanyProfileAgentConfirmRequest.parse(raw.request);
  try {
    const result = await withAgentAttemptContext(db, attempt, async (scoped) => {
      const [row] = await rawRows<{
        receipt_id: string;
        activation_event_id: string;
        replayed: boolean;
      }>(
        scoped,
        sql`select * from confirm_company_profile_for_attempt(
          ${attempt.accountId}::uuid,
          ${attempt.workspaceId}::uuid,
          ${attempt.sessionId}::uuid,
          ${attempt.turnId}::uuid,
          ${attempt.attemptId}::uuid,
          ${attempt.executionGeneration},
          ${request.operationId}::uuid,
          ${request.proposalReceiptId}::uuid,
          ${request.humanInputRequestId}::uuid
        )`,
      );
      if (!row) throw new Error("Company-profile confirmation returned no receipt");
      return row;
    });
    const [inventory, event] = await Promise.all([
      listCompanyProfile(db, {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        limit: 1,
      }),
      getCompanyProfileActivationEvent(db, {
        accountId: attempt.accountId,
        workspaceId: attempt.workspaceId,
        eventId: result.activation_event_id,
      }),
    ]);
    if (!event?.newRevision) {
      throw new Error("Company-profile confirmation activation event is unavailable");
    }
    const revision = await getCompanyProfileRevision(db, {
      accountId: attempt.accountId,
      workspaceId: attempt.workspaceId,
      revisionId: event.newRevision.id,
    });
    return CompanyProfileAgentConfirmationReceipt.parse({
      status: "activated",
      operationId: request.operationId,
      confirmationReceiptId: result.receipt_id,
      proposalReceiptId: request.proposalReceiptId,
      humanInputRequestId: request.humanInputRequestId,
      mutation: {
        revision,
        head: inventory.current?.revisionId === revision.id ? inventory.current : null,
        event,
      },
      replayed: result.replayed,
    });
  } catch (error) {
    translate(error, "confirm");
  }
}
