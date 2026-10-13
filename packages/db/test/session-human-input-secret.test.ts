import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing";
import type { HumanInputQuestion } from "@opengeni/contracts";
import {
  HumanInputResponseValidationError,
  acceptSessionHumanInputResponse,
  applySessionTurnSettlement,
  bootstrapWorkspace,
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  decryptEnvironmentValue,
  encryptEnvironmentValue,
  submitHumanPromptInTransaction,
  withWorkspaceSubjectSessionActivityRls as withWorkspaceSubjectRls,
  type PreparedSecretAnswer,
} from "../src/index";

let shared: SharedTestDatabase;
let client: ReturnType<typeof createDb>;
const KEY = new Uint8Array(32).fill(7);

setDefaultTimeout(30_000);

beforeAll(async () => {
  const acquired = await acquireSharedTestDatabase("session-human-input-secret");
  if (!acquired) throw new Error("PostgreSQL test database unavailable");
  shared = acquired;
  client = createDb(shared.appUrl);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 60_000);

const SECRET_QUESTION: HumanInputQuestion = {
  id: "github_password",
  kind: "secret",
  prompt: "Enter the password for GitHub.",
  options: [],
  required: true,
  allowOther: false,
  secret: {
    item: "GitHub",
    field: "password",
    fieldKind: "concealed",
    itemType: "login",
    website: "https://github.com",
    username: { prompt: "Email" },
    saveTo: "user",
    allowGenerate: true,
    autocomplete: "current-password",
  },
};

const CHOICE_QUESTION: HumanInputQuestion = {
  id: "environment",
  kind: "single_select",
  prompt: "Which environment?",
  options: [
    { id: "staging", label: "Staging" },
    { id: "production", label: "Production" },
  ],
  required: true,
  allowOther: false,
};

async function freezeSecretRequest() {
  const suffix = crypto.randomUUID();
  const access = await bootstrapWorkspace(client.db, {
    accountExternalSource: "test",
    accountExternalId: `secret-input-account-${suffix}`,
    accountName: "Secret input test",
    workspaceExternalSource: "test",
    workspaceExternalId: `secret-input-workspace-${suffix}`,
    workspaceName: "Secret input test",
    subjectId: `user:${suffix}`,
  });
  const grant = access.workspaceGrants[0]!;
  const workspaceId = grant.workspaceId!;
  // Only-me vaults belong to an active organization member.
  const [personal] = await shared.admin<Array<{ id: string }>>`
    insert into workspaces (account_id, name) values (${grant.accountId}::uuid, 'Personal')
    returning id::text as id`;
  await shared.admin`
    insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
    values (${grant.accountId}::uuid, ${grant.subjectId}, 'active', 'member', ${personal!.id}::uuid)
    on conflict do nothing`;
  const session = await createSession(client.db, {
    accountId: grant.accountId,
    workspaceId,
    initialMessage: "Log in to GitHub",
    resources: [],
    metadata: {},
    model: "scripted-model",
    reasoningEffort: "medium" as const,
    latencyMode: "standard" as const,
    sandboxBackend: "none",
  });
  await withWorkspaceSubjectRls(client.db, workspaceId, grant.subjectId, (db) =>
    db.transaction((tx) =>
      submitHumanPromptInTransaction(tx as unknown as typeof db, {
        accountId: grant.accountId,
        workspaceId,
        sessionId: session.id,
        subjectId: grant.subjectId,
        actor: { type: "human", subjectId: grant.subjectId },
        operationKey: crypto.randomUUID(),
        delivery: "send",
        text: "continue",
        resources: [],
        reasoningEffortFallback: "low",
        source: "user",
      }),
    ),
  );
  const attemptId = crypto.randomUUID();
  const claim = await claimSessionWorkForAttempt(client.db, workspaceId, {
    sessionId: session.id,
    workflowId: `session-${session.id}`,
    workflowRunId: crypto.randomUUID(),
    dispatchId: crypto.randomUUID(),
    attemptId,
    trigger: { kind: "next" },
  });
  if (claim.action !== "claimed") throw new Error(`could not claim fixture: ${claim.reason}`);
  const turn = claim.turn;
  const requestId = crypto.randomUUID();
  const questions = [SECRET_QUESTION, CHOICE_QUESTION];
  const settlement = await applySessionTurnSettlement(client.db, workspaceId, {
    sessionId: session.id,
    turnId: turn.id,
    triggerEventId: turn.triggerEventId,
    attemptId,
    turnStatus: "requires_action",
    sessionStatus: "requires_action",
    activeTurnId: turn.id,
    runState: {
      serializedRunState: JSON.stringify({ version: 1, interrupted: true }),
      pendingApprovals: [],
      humanInputRequests: [
        {
          id: requestId,
          toolCallId: "secret-call-1",
          questions,
          allowSkip: false,
          expiresAt: null,
        },
      ],
    },
    events: [
      {
        type: "session.humanInput.requested" as const,
        payload: {
          request: { id: requestId, questions, allowSkip: false, expiresAt: null },
        },
      },
      { type: "session.status.changed", payload: { status: "requires_action" } },
    ],
  });
  expect(settlement.action).toBe("settled");
  return { grant, workspaceId, session, turn, requestId, attemptId };
}

function prepared(
  value: string,
  overrides: Partial<PreparedSecretAnswer> = {},
): PreparedSecretAnswer {
  const username = "octo@example.test";
  return {
    questionId: SECRET_QUESTION.id,
    saveTo: "user",
    value: {
      valueEncrypted: encryptEnvironmentValue(KEY, value),
      valueSize: Buffer.byteLength(value),
    },
    username: {
      plain: username,
      valueEncrypted: encryptEnvironmentValue(KEY, username),
      valueSize: username.length,
    },
    generated: false,
    ...overrides,
  };
}

async function vaultItemsNamed(accountId: string, name: string) {
  return await shared.admin<
    Array<{ id: string; vault_id: string; field: string; ciphertext: string }>
  >`
    select item.id, item.vault_id, field.name as field, version.value_encrypted as ciphertext
    from vault_items item
    join vault_item_fields field on field.item_id = item.id
    join vault_field_versions version
      on version.field_id = field.id and version.version = field.current_version
    where item.account_id = ${accountId} and item.name = ${name}
    order by field.name`;
}

function respond(
  fixture: Awaited<ReturnType<typeof freezeSecretRequest>>,
  input: {
    answers: Array<{ questionId: string; values: string[]; secret?: unknown }>;
    secretAnswers?: PreparedSecretAnswer[];
    canonicalHumanSession?: boolean;
    respondedBy?: string;
  },
) {
  return acceptSessionHumanInputResponse(client.db, {
    accountId: fixture.grant.accountId,
    workspaceId: fixture.workspaceId,
    sessionId: fixture.session.id,
    requestId: fixture.requestId,
    response: { outcome: "answered", answers: input.answers },
    respondedBy: input.respondedBy ?? fixture.grant.subjectId,
    canonicalHumanSession: input.canonicalHumanSession ?? true,
    ...(input.secretAnswers
      ? {
          secretAnswers: input.secretAnswers,
          secretWriteContext: {
            kind: "subject" as const,
            accountId: fixture.grant.accountId,
            workspaceId: fixture.workspaceId,
            subjectId: fixture.grant.subjectId,
          },
        }
      : {}),
  });
}

describe("secret ask-card answers", () => {
  test("writes the value to the vault in the accept transaction and stores only the reference (AC-2, AC-3)", async () => {
    const fixture = await freezeSecretRequest();
    const canary = `canary-${crypto.randomUUID()}`;
    const accepted = await respond(fixture, {
      answers: [
        // A client-supplied `secret` is server-owned and must be ignored.
        {
          questionId: SECRET_QUESTION.id,
          values: [],
          secret: {
            reference: "{{secret:forged}}",
            username: "forged",
            vaultName: "forged",
            itemName: "forged",
            saveTo: "workspace",
          },
        },
        { questionId: CHOICE_QUESTION.id, values: ["staging"] },
      ],
      secretAnswers: [prepared(canary)],
    });
    expect(accepted.action).toBe("accepted");
    if (accepted.action !== "accepted") return;
    const answer =
      accepted.request.response?.outcome === "answered"
        ? accepted.request.response.answers.find((entry) => entry.questionId === SECRET_QUESTION.id)
        : undefined;
    expect(answer?.values).toEqual([answer!.secret!.reference]);
    expect(answer?.secret).toMatchObject({
      username: "octo@example.test",
      itemName: "GitHub",
      saveTo: "user",
    });
    expect(answer!.secret!.reference).toMatch(/^\{\{secret:.+\/GitHub\/password\}\}$/);

    const items = await vaultItemsNamed(fixture.grant.accountId, "GitHub");
    expect(items.map((item) => item.field)).toEqual(["password", "username"]);
    expect(decryptEnvironmentValue(KEY, items[0]!.ciphertext)).toBe(canary);

    const leaks = await shared.admin<Array<{ hits: number }>>`
      select
        (select count(*)::int from session_events
          where session_id = ${fixture.session.id} and payload::text like ${`%${canary}%`})
        + (select count(*)::int from session_human_input_requests
          where session_id = ${fixture.session.id}
            and (response::text like ${`%${canary}%`} or questions::text like ${`%${canary}%`}))
        as hits`;
    expect(leaks[0]?.hits).toBe(0);
    const [event] = await shared.admin<Array<{ payload: string }>>`
      select payload::text as payload from session_events
      where session_id = ${fixture.session.id} and type = 'user.humanInputResponse'`;
    expect(event?.payload).toContain(answer!.secret!.reference);
    expect(event?.payload).not.toContain("secretAnswers");
    expect(event?.payload).not.toContain("forged");
  });

  test("a failure after the item write rolls back both the answer and the item (AC-2)", async () => {
    const fixture = await freezeSecretRequest();
    const trigger = `fail_secret_answer_${fixture.session.id.replaceAll("-", "")}`;
    await shared.admin.unsafe(`
      create function ${trigger}() returns trigger language plpgsql as $$
      begin
        if new.session_id = '${fixture.session.id}'::uuid and new.type = 'user.humanInputResponse' then
          raise exception 'injected failure after the vault write';
        end if;
        return new;
      end $$;
      create trigger ${trigger} before insert on session_events
        for each row execute function ${trigger}();
    `);
    try {
      const failure = await respond(fixture, {
        answers: [{ questionId: CHOICE_QUESTION.id, values: ["staging"] }],
        secretAnswers: [prepared(`rollback-${crypto.randomUUID()}`)],
      }).then(
        () => null,
        (error: unknown) => error as Error & { cause?: Error },
      );
      // The vault write ran (the reference is in the event payload) and the
      // injected failure fired afterwards.
      expect(failure?.cause?.message).toContain("injected failure after the vault write");
      expect(failure?.message).toContain("{{secret:Private/GitHub/password}}");
    } finally {
      await shared.admin.unsafe(`
        drop trigger if exists ${trigger} on session_events;
        drop function if exists ${trigger}();
      `);
    }
    expect(await vaultItemsNamed(fixture.grant.accountId, "GitHub")).toHaveLength(0);
    const [request] = await shared.admin<Array<{ status: string; response: unknown }>>`
      select status, response from session_human_input_requests where id = ${fixture.requestId}`;
    expect(request).toEqual({ status: "pending", response: null });
  });

  test("an Only-me answer saves only for the person the task works for, in their personal workspace", async () => {
    const fixture = await freezeSecretRequest();
    const other = `user:other-${crypto.randomUUID()}`;
    const [otherHome] = await shared.admin<Array<{ id: string }>>`
      insert into workspaces (account_id, name) values (${fixture.grant.accountId}::uuid, 'Other')
      returning id::text as id`;
    await shared.admin`
      insert into organization_memberships (account_id, subject_id, status, role, personal_workspace_id)
      values (${fixture.grant.accountId}::uuid, ${other}, 'active', 'member', ${otherHome!.id}::uuid)`;
    await expect(
      acceptSessionHumanInputResponse(client.db, {
        accountId: fixture.grant.accountId,
        workspaceId: fixture.workspaceId,
        sessionId: fixture.session.id,
        requestId: fixture.requestId,
        response: {
          outcome: "answered",
          answers: [{ questionId: CHOICE_QUESTION.id, values: ["staging"] }],
        },
        respondedBy: other,
        canonicalHumanSession: true,
        secretAnswers: [prepared("someone else's value")],
        secretWriteContext: {
          kind: "subject" as const,
          accountId: fixture.grant.accountId,
          workspaceId: fixture.workspaceId,
          subjectId: other,
        },
      }),
    ).rejects.toThrow(/only the person this task works for/);
    expect(await vaultItemsNamed(fixture.grant.accountId, "GitHub")).toHaveLength(0);

    const accepted = await respond(fixture, {
      answers: [{ questionId: CHOICE_QUESTION.id, values: ["staging"] }],
      secretAnswers: [prepared("the owner's value")],
    });
    expect(accepted.action).toBe("accepted");
    const [home] = await shared.admin<Array<{ vault_workspace: string; personal: string }>>`
      select vault.workspace_id::text as vault_workspace,
        membership.personal_workspace_id::text as personal
      from vaults vault
      join organization_memberships membership
        on membership.id = vault.owner_organization_membership_id
      where vault.account_id = ${fixture.grant.accountId}::uuid and vault.owner_kind = 'user'`;
    expect(home!.vault_workspace).toBe(home!.personal);
    expect(home!.vault_workspace).not.toBe(fixture.workspaceId);
  });

  test("saving to Only me needs a person signed in", async () => {
    const fixture = await freezeSecretRequest();
    await expect(
      respond(fixture, {
        answers: [{ questionId: CHOICE_QUESTION.id, values: ["staging"] }],
        secretAnswers: [prepared("value")],
        canonicalHumanSession: false,
      }),
    ).rejects.toMatchObject({ code: "HUMAN_AUTH_REQUIRED" });
    expect(await vaultItemsNamed(fixture.grant.accountId, "GitHub")).toHaveLength(0);
  });

  test("an agent relays a reference but never a plain value (AC-7)", async () => {
    const fixture = await freezeSecretRequest();
    await expect(
      respond(fixture, {
        answers: [
          { questionId: SECRET_QUESTION.id, values: ["hunter2"] },
          { questionId: CHOICE_QUESTION.id, values: ["staging"] },
        ],
      }),
    ).rejects.toBeInstanceOf(HumanInputResponseValidationError);
    const accepted = await respond(fixture, {
      answers: [
        { questionId: SECRET_QUESTION.id, values: ["{{secret:Shared/GitHub/password}}"] },
        { questionId: CHOICE_QUESTION.id, values: ["staging"] },
      ],
    });
    expect(accepted.action).toBe("accepted");
  });

  test("secret answers for a non-secret question, or twice for one question, are refused", async () => {
    const fixture = await freezeSecretRequest();
    await expect(
      respond(fixture, {
        answers: [{ questionId: CHOICE_QUESTION.id, values: ["staging"] }],
        secretAnswers: [prepared("value", { questionId: CHOICE_QUESTION.id })],
      }),
    ).rejects.toBeInstanceOf(HumanInputResponseValidationError);
    await expect(
      respond(fixture, {
        answers: [{ questionId: CHOICE_QUESTION.id, values: ["staging"] }],
        secretAnswers: [prepared("one"), prepared("two")],
      }),
    ).rejects.toBeInstanceOf(HumanInputResponseValidationError);
    await expect(
      respond(fixture, {
        answers: [
          { questionId: SECRET_QUESTION.id, values: ["{{secret:GitHub}}"] },
          { questionId: CHOICE_QUESTION.id, values: ["staging"] },
        ],
        secretAnswers: [prepared("both")],
      }),
    ).rejects.toBeInstanceOf(HumanInputResponseValidationError);
    expect(await vaultItemsNamed(fixture.grant.accountId, "GitHub")).toHaveLength(0);
  });
});
