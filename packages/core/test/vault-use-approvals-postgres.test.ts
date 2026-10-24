// "Ask me each time" against PostgreSQL (0952): marked items and fields stop
// an agent's use before any value is read and return a host-owned approval
// card; the person's decision becomes a grant that is used up (once), stays in
// one chat (session), or covers their chats for an hour (window). Revoked,
// expired and denied approvals cover nothing. People resolving their own
// references are not asked, a run that acts for nobody is refused, and a
// connected vault behaves like a hosted one.
import { afterAll, beforeAll, describe, expect, setDefaultTimeout, test } from "bun:test";
import {
  isSecretReferenceError,
  parseSecretReference,
  secretUseApprovalIdFromQuestionId,
  SECRET_USE_APPROVAL_QUESTION_PREFIX,
  type SecretPrincipal,
  type SecretReferenceError,
  type SecretUseApprovalDecision,
} from "@opengeni/contracts";
import {
  claimSessionWorkForAttempt,
  createDb,
  createSession,
  createVault,
  decideSecretUseApprovalTx,
  encryptEnvironmentValue,
  ensureManagedAccessForUser,
  initializeSessionStartAtomically,
  linkProviderVault,
  upsertVaultItem,
  withRlsContext,
  type DbClient,
  type VaultDbContext,
} from "@opengeni/db";
import { createVaultProviderRegistry } from "@opengeni/vaults";
import { createFakeVaultProvider } from "@opengeni/vaults/testing/fake-provider";
import { acquireSharedTestDatabase, type SharedTestDatabase } from "@opengeni/testing/shared-pg";
import {
  createSecretResolver,
  createVaultService,
  getVaultItemApproval,
  revokeVaultItemGrant,
  setVaultItemApproval,
} from "../src/domain/vaults";
import { syncLinkedProviderVault } from "../src/domain/vaults/provider-sync";

setDefaultTimeout(180_000);

const key = new Uint8Array(32).fill(13);
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("vault-use-approvals");
  if (!shared) {
    if (process.env.OPENGENI_REQUIRE_REAL_DB === "1")
      throw new Error("Real PostgreSQL is required");
    return;
  }
  client = createDb(shared.appUrl, { max: 4 });
}, 180_000);

afterAll(async () => {
  await client?.close().catch(() => undefined);
  await shared?.release();
}, 180_000);

// Built at runtime so tooling never treats them as live references.
const ref = (path: string) => parseSecretReference(["{{secret", `${path}}}`].join(":"));
const use = { surface: "shell", toolName: "exec_command" } as const;

async function world() {
  const db = client!.db;
  const userId = `vault-use-approvals-${crypto.randomUUID()}`;
  const access = await ensureManagedAccessForUser(db, {
    userId,
    email: `${userId}@example.test`,
    name: "Approver",
  });
  const grant = access.workspaceGrants[0]!;
  const subjectId = `user:${userId}`;
  const scope = { accountId: grant.accountId, workspaceId: grant.workspaceId };
  const context: VaultDbContext = { kind: "subject", ...scope, subjectId };
  // The person on the item's page: a signed-in human session.
  const person = {
    grant: { ...grant, principalKind: "human_session" as const, serviceInitiator: false },
    accountAdmin: false,
    personSignedIn: true,
  };
  const human: SecretPrincipal = {
    kind: "human",
    ...scope,
    subjectId,
    verifiedHuman: true,
    viaApiKey: false,
  };
  const vault = await createVault(db, context, { name: "Team", ownerKind: "workspace" });
  const login = await upsertVaultItem(db, context, {
    vaultId: vault.id,
    name: "GitHub",
    type: "login",
    fields: [
      { name: "username", kind: "text" as const, value: "octo" },
      { name: "password", kind: "concealed" as const, value: "hunter2" },
    ].map((field) => ({
      name: field.name,
      kind: field.kind,
      valueEncrypted: encryptEnvironmentValue(Buffer.from(key), field.value),
      valueSize: Buffer.byteLength(field.value),
    })),
  });

  /** A new chat for this person (or for nobody) with a claimed agent attempt. */
  async function chat(options: { actsForPerson?: boolean } = {}) {
    const actsForPerson = options.actsForPerson ?? true;
    const session = await createSession(db, {
      ...scope,
      initialMessage: "deploy",
      resources: [],
      metadata: {},
      model: "scripted-model",
      reasoningEffort: "medium",
      latencyMode: "standard",
      sandboxBackend: "none",
      ...(actsForPerson ? { createdBy: { kind: "subject" as const, subjectId }, subjectId } : {}),
    });
    const started = await initializeSessionStartAtomically(db, {
      ...scope,
      sessionId: session.id,
      reasoningEffortFallback: "low",
      createdEventPayload: {},
    });
    if (!started.turn) throw new Error("initial turn was not created");
    const attemptId = crypto.randomUUID();
    const claimed = await claimSessionWorkForAttempt(db, scope.workspaceId, {
      sessionId: session.id,
      workflowId: `session-${session.id}`,
      workflowRunId: crypto.randomUUID(),
      dispatchId: crypto.randomUUID(),
      attemptId,
      trigger: { kind: "next" },
    });
    if (claimed.action !== "claimed") throw new Error(`claim failed: ${claimed.reason}`);
    const principal: SecretPrincipal = {
      kind: "attempt",
      ...scope,
      sessionId: session.id,
      turnId: claimed.turn.id,
      attemptId,
      executionGeneration: claimed.turn.executionGeneration,
    };
    return { sessionId: session.id, principal };
  }

  const resolverFor = (
    principal: SecretPrincipal,
    providers?: ReturnType<typeof createVaultProviderRegistry>,
  ) =>
    createSecretResolver(
      { db, encryptionKey: key, ...(providers ? { providers } : {}) },
      principal,
      { capabilityEnabled: true },
    );

  /** The value, or the typed refusal it was stopped with. */
  async function attempt(
    principal: SecretPrincipal,
    paths: string[],
    providers?: ReturnType<typeof createVaultProviderRegistry>,
  ): Promise<{ values: string[] } | { error: SecretReferenceError }> {
    try {
      const resolved = await resolverFor(principal, providers).resolve(paths.map(ref), use);
      return {
        values: [...resolved.values()].map((value) =>
          value.material.type === "text" ? value.material.value : "<bytes>",
        ),
      };
    } catch (error) {
      if (!isSecretReferenceError(error)) throw error;
      return { error: error as SecretReferenceError };
    }
  }

  function approvalIdOf(outcome: Awaited<ReturnType<typeof attempt>>): string {
    if (!("error" in outcome)) throw new Error("the use was not stopped");
    expect(outcome.error.failures.map((failure) => failure.code)).toContain("approval_required");
    const questionId = outcome.error.approvalCard?.questions[0]?.id ?? "";
    const id = secretUseApprovalIdFromQuestionId(questionId);
    if (!id) throw new Error(`no approval card: ${questionId}`);
    return id;
  }

  async function decide(
    sessionId: string,
    approvalId: string,
    decision: SecretUseApprovalDecision,
  ) {
    return await withRlsContext(db, scope, (tx) =>
      decideSecretUseApprovalTx(tx, {
        workspaceId: scope.workspaceId,
        sessionId,
        approvalId,
        decision,
        subjectId,
        now: new Date(),
      }),
    );
  }

  const mark = (itemId: string, request: { item: boolean; fields: string[] }) =>
    setVaultItemApproval({ db, encryptionKey: key }, person, scope.workspaceId, itemId, request);

  const approvalRow = async (id: string) =>
    (
      await shared!.admin<
        Array<{
          status: string;
          scope: string | null;
          expires_at: Date | null;
          destination: string | null;
        }>
      >`select status, scope, expires_at, destination from secret_use_approvals where id = ${id}::uuid`
    )[0]!;

  return {
    db,
    scope,
    subjectId,
    context,
    person,
    human,
    vault,
    login,
    chat,
    attempt,
    approvalIdOf,
    decide,
    mark,
    approvalRow,
  };
}

describe.skipIf(!process.env.OPENGENI_TEST_PG_URL && process.env.OPENGENI_REQUIRE_REAL_DB !== "1")(
  "approval for each use (PostgreSQL)",
  () => {
    test("an item mark gates every field, a field mark only that field, unmarked items resolve", async () => {
      if (!client) return;
      const w = await world();
      const a = await w.chat();
      expect(await w.attempt(a.principal, ["GitHub/username", "GitHub/password"])).toEqual({
        values: ["octo", "hunter2"],
      });

      const marked = await w.mark(w.login.id, { item: false, fields: ["Password"] });
      expect(marked).toMatchObject({
        item: false,
        fields: ["password"],
        grants: [],
        canChange: true,
      });
      expect(await w.attempt(a.principal, ["GitHub/username"])).toEqual({ values: ["octo"] });

      const blocked = await w.attempt(a.principal, ["GitHub/username", "GitHub/password"]);
      const approvalId = w.approvalIdOf(blocked);
      if (!("error" in blocked)) return;
      // Only the marked reference is refused; the card is host-owned and names
      // the item, field and surface, never a value.
      expect(blocked.error.failures).toEqual([
        expect.objectContaining({
          code: "approval_required",
          raw: expect.stringContaining("password"),
        }),
      ]);
      const card = blocked.error.approvalCard!;
      expect(card.allowSkip).toBe(false);
      expect(card.questions[0]).toMatchObject({
        id: `${SECRET_USE_APPROVAL_QUESTION_PREFIX}${approvalId}`,
        kind: "single_select",
        allowOther: false,
        options: [
          expect.objectContaining({ id: "once" }),
          expect.objectContaining({ id: "session" }),
          expect.objectContaining({ id: "window" }),
          expect.objectContaining({ id: "deny" }),
        ],
      });
      expect(card.questions[0]!.prompt).toBe(
        "Allow the agent to use GitHub › password in a shell command?",
      );
      const output = blocked.error.toModelOutput();
      expect(JSON.parse(output)).toMatchObject({
        approvalCard: JSON.parse(JSON.stringify(card)),
        askCard: null,
      });
      expect(output).not.toContain("hunter2");
      expect(output).not.toContain('octo"');

      // The same blocked use asks with the same pending request.
      expect(w.approvalIdOf(await w.attempt(a.principal, ["GitHub/password"]))).toBe(approvalId);

      // secret_get never shows a marked value to an agent, even with
      // secrets:read; an unmarked field of the same item still reads.
      const agentVaults = createVaultService({ db: w.db, encryptionKey: key });
      await expect(
        agentVaults.readForAgent(a.principal, { reference: "GitHub/password" }, ["secrets:read"]),
      ).rejects.toMatchObject({ code: "vault_permission_denied" });
      expect(
        await agentVaults.readForAgent(a.principal, { reference: "GitHub/username" }, [
          "secrets:read",
        ]),
      ).toMatchObject({ value: "octo" });

      await w.mark(w.login.id, { item: true, fields: ["password"] });
      expect(w.approvalIdOf(await w.attempt(a.principal, ["GitHub/username"]))).not.toBe(
        approvalId,
      );
      expect(
        await getVaultItemApproval(
          { db: w.db, encryptionKey: key },
          w.person,
          w.scope.workspaceId,
          w.login.id,
        ),
      ).toMatchObject({
        item: true,
        fields: ["password"],
      });
      await w.mark(w.login.id, { item: false, fields: [] });
      expect(await w.attempt(a.principal, ["GitHub/password"])).toEqual({ values: ["hunter2"] });

      // Unknown fields are refused; nobody but a signed-in person changes marks.
      await expect(w.mark(w.login.id, { item: false, fields: ["pin"] })).rejects.toMatchObject({
        code: "vault_field_not_found",
      });
      const apiKey = {
        grant: { ...w.person.grant, principalKind: "api_key" as const },
        accountAdmin: false,
      };
      // An agent or personal key acting as the person resolves as their human
      // session, but not as their own sign-in.
      const actingAsPerson = { ...w.person, personSignedIn: false };
      for (const caller of [apiKey, actingAsPerson]) {
        await expect(
          setVaultItemApproval(
            { db: w.db, encryptionKey: key },
            caller,
            w.scope.workspaceId,
            w.login.id,
            {
              item: true,
              fields: [],
            },
          ),
        ).rejects.toMatchObject({ code: "human_auth_required" });
        expect(
          (
            await getVaultItemApproval(
              { db: w.db, encryptionKey: key },
              caller,
              w.scope.workspaceId,
              w.login.id,
            )
          ).canChange,
        ).toBe(false);
      }
    });

    test("once is used up, a chat grant stays in its chat, an hour grant covers the person's chats, deny covers nothing", async () => {
      if (!client) return;
      const w = await world();
      await w.mark(w.login.id, { item: false, fields: ["password"] });
      const a = await w.chat();
      const b = await w.chat();

      const first = w.approvalIdOf(await w.attempt(a.principal, ["GitHub/password"]));
      expect((await w.decide(a.sessionId, first, "once"))?.status).toBe("approved");
      // The first decision stands.
      expect(await w.decide(a.sessionId, first, "window")).toBeNull();
      expect(await w.attempt(a.principal, ["GitHub/password"])).toEqual({ values: ["hunter2"] });
      expect(await w.approvalRow(first)).toMatchObject({ status: "used", scope: "once" });
      const second = w.approvalIdOf(await w.attempt(a.principal, ["GitHub/password"]));
      expect(second).not.toBe(first);

      await w.decide(a.sessionId, second, "session");
      expect(await w.approvalRow(second)).toMatchObject({ status: "approved", expires_at: null });
      expect(await w.attempt(a.principal, ["GitHub/password"])).toEqual({ values: ["hunter2"] });
      expect(await w.attempt(a.principal, ["GitHub/password"])).toEqual({ values: ["hunter2"] });
      const other = w.approvalIdOf(await w.attempt(b.principal, ["GitHub/password"]));

      await w.decide(b.sessionId, other, "deny");
      expect(await w.approvalRow(other)).toMatchObject({ status: "denied", scope: null });
      const again = w.approvalIdOf(await w.attempt(b.principal, ["GitHub/password"]));
      expect(again).not.toBe(other);

      // A decision is bound to its own chat.
      expect(await w.decide(a.sessionId, again, "window")).toBeNull();
      await w.decide(b.sessionId, again, "window");
      expect(await w.attempt(b.principal, ["GitHub/password"])).toEqual({ values: ["hunter2"] });
      const c = await w.chat();
      expect(await w.attempt(c.principal, ["GitHub/password"])).toEqual({ values: ["hunter2"] });

      // The audit of an approved use names the approvals it relied on.
      const audited = await shared!.admin<Array<{ approval_ids: string[] }>>`
        select metadata -> 'approvalIds' as approval_ids from audit_events
        where account_id = ${w.scope.accountId}::uuid and action = 'vault.secret.used'
          and metadata ? 'approvalIds'`;
      expect(audited.map((row) => row.approval_ids.join(",")).sort()).toEqual(
        [first, second, second, again, again].sort(),
      );
    });

    test("two calls racing for one once approval: one uses it, the other asks again", async () => {
      if (!client) return;
      const w = await world();
      await w.mark(w.login.id, { item: false, fields: ["password"] });
      const a = await w.chat();
      const granted = w.approvalIdOf(await w.attempt(a.principal, ["GitHub/password"]));
      await w.decide(a.sessionId, granted, "once");
      const outcomes = await Promise.all([
        w.attempt(a.principal, ["GitHub/password"]),
        w.attempt(a.principal, ["GitHub/password"]),
      ]);
      expect(outcomes.filter((outcome) => "values" in outcome)).toEqual([{ values: ["hunter2"] }]);
      const asked = outcomes.find((outcome) => "error" in outcome)!;
      expect(w.approvalIdOf(asked)).not.toBe(granted);
      expect(await w.approvalRow(granted)).toMatchObject({ status: "used" });
    });

    test("the card names where the value goes, looked up only when asking", async () => {
      if (!client) return;
      const w = await world();
      await w.mark(w.login.id, { item: false, fields: ["password"] });
      const a = await w.chat();
      const resolver = createSecretResolver({ db: w.db, encryptionKey: key }, a.principal, {
        capabilityEnabled: true,
      });
      let lookups = 0;
      const browser = {
        surface: "browser",
        toolName: "browser_act",
        lookupDestination: async () => {
          lookups += 1;
          return "github.com";
        },
      } as const;
      await resolver.resolve([ref("GitHub/username")], browser);
      expect(lookups).toBe(0);
      const error = await resolver.resolve([ref("GitHub/password")], browser).then(
        () => null,
        (caught: SecretReferenceError) => caught,
      );
      expect(lookups).toBe(1);
      expect(error?.approvalCard?.questions[0]?.prompt).toBe(
        "Allow the agent to use GitHub › password in the browser on github.com?",
      );
      const approvalId = w.approvalIdOf({ error: error! });
      expect(await w.approvalRow(approvalId)).toMatchObject({ destination: "github.com" });

      const machine = await resolver
        .resolve([ref("GitHub/password")], {
          surface: "run_on",
          toolName: "run_on",
          destination: "build-box",
        })
        .then(
          () => null,
          (caught: SecretReferenceError) => caught,
        );
      expect(machine?.approvalCard?.questions[0]?.prompt).toBe(
        "Allow the agent to use GitHub › password in a command on build-box?",
      );
      // The lookup failing still asks, without a destination.
      const failing = await resolver
        .resolve([ref("GitHub/password")], {
          surface: "browser",
          toolName: "browser_act",
          lookupDestination: async () => {
            throw new Error("browser gone");
          },
        })
        .then(
          () => null,
          (caught: SecretReferenceError) => caught,
        );
      expect(failing?.approvalCard?.questions[0]?.prompt).toBe(
        "Allow the agent to use GitHub › password in the browser?",
      );
    });

    test("revoked and expired approvals cover nothing; people are not asked; a run for nobody is refused", async () => {
      if (!client) return;
      const w = await world();
      await w.mark(w.login.id, { item: true, fields: [] });
      const a = await w.chat();
      const deps = { db: w.db, encryptionKey: key };

      const chatGrant = w.approvalIdOf(await w.attempt(a.principal, ["GitHub/password"]));
      await w.decide(a.sessionId, chatGrant, "session");
      const listed = await getVaultItemApproval(deps, w.person, w.scope.workspaceId, w.login.id);
      expect(listed.grants).toEqual([
        expect.objectContaining({
          id: chatGrant,
          scope: "session",
          sessionId: a.sessionId,
          fields: ["password"],
          surface: "shell",
          toolName: "exec_command",
          expiresAt: null,
        }),
      ]);
      await expect(
        revokeVaultItemGrant(
          deps,
          { ...w.person, personSignedIn: false },
          w.scope.workspaceId,
          w.login.id,
          chatGrant,
        ),
      ).rejects.toMatchObject({ code: "human_auth_required" });
      const revoked = await revokeVaultItemGrant(
        deps,
        w.person,
        w.scope.workspaceId,
        w.login.id,
        chatGrant,
      );
      expect(revoked.grants).toEqual([]);
      await expect(
        revokeVaultItemGrant(deps, w.person, w.scope.workspaceId, w.login.id, chatGrant),
      ).rejects.toMatchObject({ code: "vault_item_not_found" });
      await expect(
        revokeVaultItemGrant(deps, w.person, w.scope.workspaceId, w.login.id, "not-a-uuid"),
      ).rejects.toMatchObject({ code: "vault_item_not_found" });
      const hourGrant = w.approvalIdOf(await w.attempt(a.principal, ["GitHub/password"]));
      expect(hourGrant).not.toBe(chatGrant);

      await w.decide(a.sessionId, hourGrant, "window");
      expect(await w.attempt(a.principal, ["GitHub/password"])).toEqual({ values: ["hunter2"] });
      await shared!.admin`
        update secret_use_approvals set expires_at = now() - interval '1 second'
        where id = ${hourGrant}::uuid`;
      expect(w.approvalIdOf(await w.attempt(a.principal, ["GitHub/password"]))).not.toBe(hourGrant);

      // A person using their own reference is the one who would approve.
      expect(await w.attempt(w.human, ["GitHub/password"])).toEqual({ values: ["hunter2"] });

      // A run that acts for nobody has nobody to ask.
      const nobody = await w.chat({ actsForPerson: false });
      const refused = await w.attempt(nobody.principal, ["GitHub/password"]);
      expect("error" in refused && refused.error.failures.map((failure) => failure.code)).toEqual([
        "denied",
      ]);
      expect("error" in refused && refused.error.approvalCard).toBeNull();
    });

    test("a connected vault's marked field is refused before the provider is read", async () => {
      if (!client) return;
      const w = await world();
      const host = createFakeVaultProvider({
        vaults: [
          {
            externalVaultId: "company",
            name: "Company",
            items: [
              {
                name: "Card",
                type: "api_key",
                fields: [
                  { name: "holder", value: "Ada" },
                  { name: "number", value: "4111111111111111" },
                ],
              },
            ],
          },
        ],
      });
      const providers = createVaultProviderRegistry({ host: async () => host });
      const vault = await linkProviderVault(w.db, w.context, {
        ownerKind: "workspace",
        name: "Company",
        source: "host",
        providerVaultRef: "company",
        mode: "read_only",
      });
      await syncLinkedProviderVault({
        db: w.db,
        context: w.context,
        vaultId: vault.id,
        providers,
        force: true,
      });
      const service = createVaultService({ db: w.db, encryptionKey: null, providers });
      const card = (await service.listItems(w.person, w.scope.workspaceId, vault.id, {})).items[0]!;
      await w.mark(card.id, { item: false, fields: ["number"] });
      const a = await w.chat();
      const reads = () => host.calls.filter((call) => call.op === "readFields").length;

      const before = reads();
      const blocked = await w.attempt(a.principal, ["Company/Card/number"], providers);
      const approvalId = w.approvalIdOf(blocked);
      // Refused before any value was read from the password manager.
      expect(reads()).toBe(before);
      if ("error" in blocked) {
        expect(blocked.error.approvalCard?.questions[0]?.prompt).toBe(
          "Allow the agent to use Card › number in a shell command?",
        );
      }
      expect(await w.attempt(a.principal, ["Company/Card/holder"], providers)).toEqual({
        values: ["Ada"],
      });

      await w.decide(a.sessionId, approvalId, "once");
      expect(await w.attempt(a.principal, ["Company/Card/number"], providers)).toEqual({
        values: ["4111111111111111"],
      });
      w.approvalIdOf(await w.attempt(a.principal, ["Company/Card/number"], providers));
    });
  },
);
