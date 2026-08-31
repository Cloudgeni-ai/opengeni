import {
  CompanyProfileAgentPolicy,
  CompanyProfileAgentPolicyMode,
  type CompanyProfileAgentPolicy as CompanyProfileAgentPolicyType,
  type CompanyProfileAgentPolicyMode as CompanyProfileAgentPolicyModeType,
} from "@opengeni/contracts";
import { sql } from "drizzle-orm";
import { rawRows, withRlsContext, withSessionRlsActorContext, type Database } from "./database";
import { nestedPostgresSqlState } from "./persistence-errors";

export class CompanyProfileAgentPolicyError extends Error {
  readonly name = "CompanyProfileAgentPolicyError";

  constructor(
    readonly code: "authority_unavailable" | "policy_conflict" | "operation_reused" | "invalid",
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

function translate(error: unknown): never {
  const state = nestedPostgresSqlState(error);
  if (state === "42501") {
    throw new CompanyProfileAgentPolicyError(
      "authority_unavailable",
      "An active organization owner is required to manage company-profile agent autonomy.",
      { cause: error },
    );
  }
  if (state === "40001") {
    throw new CompanyProfileAgentPolicyError(
      "policy_conflict",
      "The company-profile agent policy changed in another request. Reload and try again.",
      { cause: error },
    );
  }
  if (state === "23505" || state === "P1851") {
    throw new CompanyProfileAgentPolicyError(
      "operation_reused",
      "The company-profile agent policy operation id was already used for different input.",
      { cause: error },
    );
  }
  if (state === "22023" || state === "23514" || state === "55000") {
    throw new CompanyProfileAgentPolicyError(
      "invalid",
      "The company-profile agent policy request is invalid.",
      { cause: error },
    );
  }
  throw error;
}

async function withHumanPolicyContext<T>(
  db: Database,
  input: { accountId: string; workspaceId: string; actorSubjectId: string },
  fn: (scoped: Database) => Promise<T>,
): Promise<T> {
  return await withSessionRlsActorContext({ subjectId: input.actorSubjectId }, async () =>
    withRlsContext(
      db,
      { accountId: input.accountId, workspaceId: input.workspaceId },
      async (scoped) => {
        await scoped.execute(
          sql`select set_config('opengeni.principal_kind', 'human_session', true)`,
        );
        return await fn(scoped);
      },
    ),
  );
}

export async function getCompanyProfileAgentPolicy(
  db: Database,
  input: { accountId: string; workspaceId: string; actorSubjectId: string },
): Promise<CompanyProfileAgentPolicyType> {
  try {
    return await withHumanPolicyContext(db, input, async (scoped) => {
      const [row] = await rawRows<{ result: unknown }>(
        scoped,
        sql`select get_company_profile_agent_policy(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.actorSubjectId}
        ) as result`,
      );
      return CompanyProfileAgentPolicy.parse(row?.result);
    });
  } catch (error) {
    translate(error);
  }
}

export async function updateCompanyProfileAgentPolicy(
  db: Database,
  input: {
    accountId: string;
    workspaceId: string;
    actorSubjectId: string;
    mode: CompanyProfileAgentPolicyModeType;
    expectedVersion: number;
    operationId: string;
  },
): Promise<CompanyProfileAgentPolicyType> {
  const mode = CompanyProfileAgentPolicyMode.parse(input.mode);
  try {
    return await withHumanPolicyContext(db, input, async (scoped) => {
      const [row] = await rawRows<{ result: unknown }>(
        scoped,
        sql`select update_company_profile_agent_policy(
          ${input.accountId}::uuid,
          ${input.workspaceId}::uuid,
          ${input.actorSubjectId},
          ${mode},
          ${input.expectedVersion}::bigint,
          ${input.operationId}::uuid
        ) as result`,
      );
      return CompanyProfileAgentPolicy.parse(row?.result);
    });
  } catch (error) {
    translate(error);
  }
}
