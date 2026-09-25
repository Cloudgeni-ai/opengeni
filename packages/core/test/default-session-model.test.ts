import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DEFAULT_OPENROUTER_MODEL_ID, type Settings } from "@opengeni/config";
import type { AccessGrant, WorkspaceModelPolicyContract } from "@opengeni/contracts";
import {
  applyCreditLedgerEntry,
  createDb,
  encryptEnvironmentValue,
  ensureCodexRotationSettings,
  saveNewSessionDraftInTransaction,
  updateCodexRotationSettings,
  upsertCodexSubscriptionCredential,
  withWorkspaceSubjectRls,
  type Database,
  type DbClient,
} from "@opengeni/db";
import {
  acquireSharedTestDatabase,
  MemoryEventBus,
  testSettings,
  type SharedTestDatabase,
} from "@opengeni/testing";
import type { ApiRouteDeps, SessionWorkflowClient } from "../src";
import {
  getActorNewSessionDefaults,
  getActorNewSessionDraft,
  saveActorNewSessionDraft,
} from "../src/application/new-session-drafts";
import {
  clampReasoningEffortForConfiguredModel,
  creditsDefaultSessionModel,
  resolveDefaultSessionModel,
  selectDefaultSessionModel,
} from "../src/default-session-model";
import { createSessionForRequest } from "../src/domain/sessions";
import { resolveWorkspaceModelSelection } from "../src/model-catalog";

// A deployment shaped like the hosted one: a free OpenRouter default, the
// OpenGeni credits catalog, and both connected-subscription rails enabled.
function hostedSettings(overrides: Partial<Settings> = {}): Settings {
  return testSettings({
    openrouterApiKey: "openrouter-test-key",
    openaiModel: DEFAULT_OPENROUTER_MODEL_ID,
    openaiAllowedModels: "gpt-6-astra,gpt-6-sol,gpt-6-luna",
    billingMode: "stripe",
    codexSubscriptionEnabled: true,
    supergrokSubscriptionEnabled: true,
    environmentsEncryptionKey: Buffer.alloc(32, 7).toString("base64"),
    ...overrides,
  });
}

function selections(
  settings: Settings,
  state: {
    codex?: boolean;
    supergrok?: boolean;
    policy?: WorkspaceModelPolicyContract | null;
  } = {},
) {
  return resolveWorkspaceModelSelection({
    settings,
    policy: state.policy ?? null,
    codexSubscriptionActive: state.codex === true,
    xaiSubscriptionActive: state.supergrok === true,
  });
}

function decide(
  settings: Settings,
  state: Parameters<typeof selections>[1] & {
    credits?: boolean;
    workspaceDefaults?: { model: string; reasoningEffort: "low" | "medium" | "high" | "xhigh" };
  } = {},
) {
  return selectDefaultSessionModel({
    settings,
    selections: selections(settings, state),
    workspaceDefaults: state.workspaceDefaults ?? null,
    creditsAvailable: state.credits === true,
  });
}

describe("default model precedence", () => {
  test("neither a subscription nor credits keeps the free deployment default", () => {
    const settings = hostedSettings();
    expect(decide(settings)).toEqual({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      reasoningEffort: settings.openaiReasoningEffort,
      source: "deployment",
    });
  });

  test("a connected ChatGPT/Codex subscription makes its default model the default", () => {
    expect(decide(hostedSettings(), { codex: true })).toEqual({
      model: "codex/gpt-6-astra",
      reasoningEffort: "high",
      source: "subscription",
    });
  });

  test("a connected SuperGrok subscription is used when it is the only one", () => {
    expect(decide(hostedSettings(), { supergrok: true })).toEqual({
      model: "supergrok/grok-4.7",
      reasoningEffort: "high",
      source: "subscription",
    });
  });

  test("a subscription wins over an OpenGeni credit balance", () => {
    expect(decide(hostedSettings(), { codex: true, credits: true }).source).toBe("subscription");
  });

  test("an OpenGeni credit balance selects GPT-6 Luna at extra high reasoning", () => {
    expect(decide(hostedSettings(), { credits: true })).toEqual({
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
      source: "credits",
    });
  });

  test("the credits default model and effort are deployment-configurable", () => {
    expect(
      decide(
        hostedSettings({
          creditsDefaultModel: "gpt-6-sol",
          creditsDefaultReasoningEffort: "medium",
        }),
        { credits: true },
      ),
    ).toEqual({ model: "gpt-6-sol", reasoningEffort: "medium", source: "credits" });
  });

  test("the credits effort is clamped to the highest one the model supports", () => {
    expect(
      decide(hostedSettings({ openaiAllowedReasoningEfforts: "low,medium,high" }), {
        credits: true,
      }),
    ).toEqual({ model: "gpt-6-luna", reasoningEffort: "high", source: "credits" });
  });

  test("an unselectable credits default falls back to the first selectable credits model", () => {
    const settings = hostedSettings();
    expect(
      decide(settings, {
        credits: true,
        policy: {
          allowedProviders: null,
          allowedModels: [DEFAULT_OPENROUTER_MODEL_ID, "gpt-6-sol"],
        },
      }),
    ).toEqual({ model: "gpt-6-sol", reasoningEffort: "high", source: "credits" });
  });

  test("credits never replace a deployment default that is already credits-billed", () => {
    const settings = hostedSettings({ openaiModel: "gpt-6-astra" });
    expect(decide(settings, { credits: true })).toEqual({
      model: "gpt-6-astra",
      reasoningEffort: settings.openaiReasoningEffort,
      source: "deployment",
    });
  });

  test("a saved workspace default is an explicit choice that beats subscriptions and credits", () => {
    expect(
      decide(hostedSettings(), {
        codex: true,
        credits: true,
        workspaceDefaults: { model: DEFAULT_OPENROUTER_MODEL_ID, reasoningEffort: "medium" },
      }),
    ).toEqual({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      reasoningEffort: "medium",
      source: "workspace",
    });
  });

  test("an unselectable saved workspace default falls through to the next rule", () => {
    expect(
      decide(hostedSettings(), {
        credits: true,
        workspaceDefaults: { model: "codex/gpt-6-sol", reasoningEffort: "high" },
      }),
    ).toEqual({ model: "gpt-6-luna", reasoningEffort: "xhigh", source: "credits" });
  });

  test("the credits selection is published only where credits are billed", () => {
    const stripe = hostedSettings();
    expect(
      creditsDefaultSessionModel({
        settings: stripe,
        selections: selections(stripe),
        workspaceSettings: {},
      }),
    ).toEqual({ model: "gpt-6-luna", reasoningEffort: "xhigh", source: "credits" });
    expect(
      creditsDefaultSessionModel({
        settings: stripe,
        selections: selections(stripe, { codex: true }),
        workspaceSettings: {},
      })?.source,
    ).toBe("subscription");
    const disabled = hostedSettings({ billingMode: "disabled" });
    expect(
      creditsDefaultSessionModel({
        settings: disabled,
        selections: selections(disabled),
        workspaceSettings: {},
      }),
    ).toBeNull();
  });

  test("effort clamping stays within the model's supported efforts", () => {
    const settings = hostedSettings();
    const free = selections(settings).find(
      (selection) => selection.model.id === DEFAULT_OPENROUTER_MODEL_ID,
    )!.model;
    expect(clampReasoningEffortForConfiguredModel(free, "xhigh", "low")).toBe("medium");
    expect(clampReasoningEffortForConfiguredModel(free, "low", "medium")).toBe("low");
  });
});

let available = true;
let shared: SharedTestDatabase | null = null;
let client: DbClient | null = null;
let db: Database;

beforeAll(async () => {
  shared = await acquireSharedTestDatabase("core-default-session-model");
  if (!shared) {
    available = false;
    return;
  }
  client = createDb(shared.appUrl);
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await shared?.release();
}, 180_000);

async function workspaceFixture(): Promise<AccessGrant & { workspaceId: string }> {
  const subjectId = `user:default-model-${crypto.randomUUID()}`;
  const suffix = crypto.randomUUID();
  const [account] = await shared!.admin<{ id: string }[]>`
    insert into managed_accounts (name) values (${`default model account ${suffix}`}) returning id`;
  const [workspace] = await shared!.admin<{ id: string }[]>`
    insert into workspaces (account_id, name)
    values (${account!.id}, ${`default model workspace ${suffix}`}) returning id`;
  await shared!.admin`
    insert into workspace_inference_controls (workspace_id, account_id)
    values (${workspace!.id}, ${account!.id})`;
  await shared!.admin`
    insert into workspace_memberships (workspace_id, account_id, subject_id, role)
    values (${workspace!.id}, ${account!.id}, ${subjectId}, 'owner')`;
  return {
    accountId: account!.id,
    workspaceId: workspace!.id,
    subjectId,
    permissions: ["sessions:read", "sessions:create"],
  };
}

async function addCredits(grant: AccessGrant & { workspaceId: string }) {
  await applyCreditLedgerEntry(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    type: "test_credit",
    amountMicros: 5_000_000,
    sourceType: "test",
    sourceId: grant.workspaceId,
    idempotencyKey: `test:default-model-credit:${grant.workspaceId}`,
  });
}

async function connectCodex(settings: Settings, grant: AccessGrant & { workspaceId: string }) {
  const key = Buffer.from(settings.environmentsEncryptionKey!, "base64");
  await upsertCodexSubscriptionCredential(db, {
    accountId: grant.accountId,
    workspaceId: grant.workspaceId,
    credentialEncrypted: encryptEnvironmentValue(
      key,
      JSON.stringify({ access_token: "test", refresh_token: "test", id_token: "test" }),
    ),
    chatgptAccountId: `default-model-${grant.workspaceId}`,
    scopes: null,
    planType: "pro",
    isFedramp: false,
    expiresAt: new Date(Date.now() + 60_000),
    lastRefreshAt: new Date(),
  });
  await ensureCodexRotationSettings(db, grant.accountId, grant.workspaceId);
  await updateCodexRotationSettings(db, grant.workspaceId, { rotationEnabled: true });
}

function routeDeps(settings: Settings): ApiRouteDeps {
  const noop = async () => undefined;
  return {
    settings,
    db,
    bus: new MemoryEventBus(),
    workflowClient: {
      signalUserMessage: noop,
      wakeSessionWorkflow: noop,
      requestSessionWorkflowWakeDispatch: noop,
      signalApprovalDecision: noop,
      signalSessionControl: noop,
      syncScheduledTask: noop,
      deleteScheduledTaskSchedule: noop,
      triggerScheduledTask: noop,
    } as unknown as SessionWorkflowClient,
    objectStorage: null,
    githubStateSecret: "test",
    documentIndexer: { indexDocument: noop },
    getDocumentServices: () => ({}) as never,
  } as unknown as ApiRouteDeps;
}

describe("server-side default model resolution", () => {
  test("resolves deployment, credits, and subscription defaults from workspace state", async () => {
    if (!available) return;
    const settings = hostedSettings();
    const grant = await workspaceFixture();
    const context = {
      accountId: grant.accountId,
      workspaceId: grant.workspaceId,
      subjectId: grant.subjectId,
    };
    expect(await resolveDefaultSessionModel(db, settings, context)).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      source: "deployment",
    });
    await addCredits(grant);
    expect(await resolveDefaultSessionModel(db, settings, context)).toEqual({
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
      source: "credits",
    });
    await connectCodex(settings, grant);
    expect(await resolveDefaultSessionModel(db, settings, context)).toEqual({
      model: "codex/gpt-6-astra",
      reasoningEffort: "high",
      source: "subscription",
    });
    expect(
      await resolveDefaultSessionModel(db, settings, {
        ...context,
        workspaceSettings: {
          sessionDefaults: { model: DEFAULT_OPENROUTER_MODEL_ID, reasoningEffort: "medium" },
        },
      }),
    ).toEqual({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      reasoningEffort: "medium",
      source: "workspace",
    });
  }, 180_000);

  test("an API create without a model uses the resolved default; an explicit model wins", async () => {
    if (!available) return;
    const settings = hostedSettings();
    const grant = await workspaceFixture();
    const deps = routeDeps(settings);
    const create = async (model?: string) =>
      await createSessionForRequest(deps, grant, grant.workspaceId, {
        initialMessage: "daily report",
        visibility: "workspace",
        resources: [],
        tools: [],
        ...(model ? { model } : {}),
        idempotencyKey: crypto.randomUUID(),
      });

    const free = await create();
    expect(free.model).toBe(DEFAULT_OPENROUTER_MODEL_ID);

    await addCredits(grant);
    const withCredits = await create();
    expect(withCredits.model).toBe("gpt-6-luna");
    expect(withCredits.reasoningEffort).toBe("xhigh");

    const explicit = await create(DEFAULT_OPENROUTER_MODEL_ID);
    expect(explicit.model).toBe(DEFAULT_OPENROUTER_MODEL_ID);

    await connectCodex(settings, grant);
    const withSubscription = await create();
    expect(withSubscription.model).toBe("codex/gpt-6-astra");

    // A saved workspace default is read from the workspace row and wins.
    await shared!.admin`
      update workspaces
      set settings = settings || ${shared!.admin.json({
        sessionDefaults: { model: "gpt-6-sol", reasoningEffort: "medium" },
      })}
      where id = ${grant.workspaceId}`;
    const saved = await create();
    expect(saved.model).toBe("gpt-6-sol");
    expect(saved.reasoningEffort).toBe("medium");
  }, 180_000);

  test("new-chat drafts follow the default until the person picks a model", async () => {
    if (!available) return;
    const settings = hostedSettings();
    const grant = await workspaceFixture();
    const draftDeps = { db, settings, objectStorage: null };

    const empty = await getActorNewSessionDraft(draftDeps, grant, grant.workspaceId);
    expect(empty).toMatchObject({
      revision: 0,
      model: DEFAULT_OPENROUTER_MODEL_ID,
      modelProvided: false,
    });

    // An untouched composer saves the free default while following it.
    const following = await saveActorNewSessionDraft(draftDeps, grant, grant.workspaceId, {
      expectedRevision: 0,
      text: "hello",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: empty.model,
      reasoningEffort: empty.reasoningEffort,
      latencyMode: "standard",
      modelProvided: false,
      options: {},
    });
    await addCredits(grant);
    const upgraded = await getActorNewSessionDraft(draftDeps, grant, grant.workspaceId);
    expect(upgraded).toMatchObject({
      revision: following.revision,
      text: "hello",
      model: "gpt-6-luna",
      reasoningEffort: "xhigh",
      modelProvided: false,
    });
    // Slack and other draft-reusing creates leave a followed model to the server.
    expect(
      await getActorNewSessionDefaults(draftDeps, grant, grant.workspaceId),
    ).not.toHaveProperty("model");

    // A chosen model is never replaced.
    await saveActorNewSessionDraft(draftDeps, grant, grant.workspaceId, {
      expectedRevision: following.revision,
      text: "hello",
      resources: [],
      tools: [],
      toolsProvided: false,
      model: DEFAULT_OPENROUTER_MODEL_ID,
      reasoningEffort: "medium",
      latencyMode: "standard",
      modelProvided: true,
      options: {},
    });
    const chosen = await getActorNewSessionDraft(draftDeps, grant, grant.workspaceId);
    expect(chosen).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      reasoningEffort: "medium",
      modelProvided: true,
    });
    expect(await getActorNewSessionDefaults(draftDeps, grant, grant.workspaceId)).toMatchObject({
      model: DEFAULT_OPENROUTER_MODEL_ID,
      reasoningEffort: "medium",
    });
  }, 180_000);

  test("a pre-marker draft holding the untouched default policy is upgraded", async () => {
    if (!available) return;
    const settings = hostedSettings();
    const grant = await workspaceFixture();
    await addCredits(grant);
    const saveLegacy = async (
      expectedRevision: number,
      reasoningEffort: "low" | "medium" | "high",
    ) =>
      await withWorkspaceSubjectRls(db, grant.workspaceId, grant.subjectId, (scoped) =>
        saveNewSessionDraftInTransaction(scoped, {
          accountId: grant.accountId,
          workspaceId: grant.workspaceId,
          subjectId: grant.subjectId,
          expectedRevision,
          text: "",
          resources: [],
          tools: [],
          toolsProvided: false,
          model: DEFAULT_OPENROUTER_MODEL_ID,
          reasoningEffort,
          latencyMode: "standard",
          options: {},
        }),
      );
    expect(settings.openaiReasoningEffort).toBe("high");
    const untouched = await saveLegacy(0, "high");
    expect(await getActorNewSessionDraft({ db, settings }, grant, grant.workspaceId)).toMatchObject(
      { model: "gpt-6-luna", reasoningEffort: "xhigh", modelProvided: false },
    );

    // A pre-marker draft that changed anything about the policy was a choice.
    await saveLegacy(untouched.revision, "medium");
    expect(await getActorNewSessionDraft({ db, settings }, grant, grant.workspaceId)).toMatchObject(
      {
        model: DEFAULT_OPENROUTER_MODEL_ID,
        reasoningEffort: "medium",
        modelProvided: true,
      },
    );
  }, 180_000);
});
