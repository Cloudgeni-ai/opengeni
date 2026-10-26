import { expect, test } from "bun:test";
import {
  ACTION_CATALOG,
  appActionCallChangesState,
  appActionCallHandlesSecrets,
  appActionCallNeedsConfirmation,
  appActionConfirmationTitle,
  appActionHandlesSecrets,
  appActionNeedsConfirmation,
  appActionPaymentPage,
  findAppAction,
  PAYMENT_PAGE_ACTIONS,
} from "../src/app-actions";
import {
  isPresentedSessionToolCall,
  presentedAppActionId,
  SESSION_EVENT_APP_ACTION_ID_SPACE,
  SESSION_EVENT_PRESENTED_APP_ACTION_NAMES,
  SESSION_EVENT_PRESENTED_APP_ACTIONS,
} from "../src/session-history";
import {
  appActionReviewSummary,
  secretFieldName,
  toolReviewAction,
  toolReviewFields,
} from "../src/tool-review-presentation";

const here = { workspaceId: "ws-1", sessionId: "chat-1" };

test("reads are told apart from changes; anything unrecognised counts as a change", () => {
  expect(appActionCallChangesState({ id: "getMyUsage" })).toBe(false);
  expect(appActionCallChangesState({ id: "listWorkspaceMembers" })).toBe(false);
  expect(appActionCallChangesState({ id: "createOrganizationInvitation" })).toBe(true);
  expect(appActionCallChangesState({ id: "updateWorkspaceSettings" })).toBe(true);
  // The JSON text the model sent reads the same.
  expect(appActionCallChangesState(JSON.stringify({ id: "getMyUsage" }))).toBe(false);
  for (const unknown of [{ id: "noSuchAction" }, {}, null, "not json", { id: 7 }]) {
    expect(appActionCallChangesState(unknown)).toBe(true);
  }
  // A read-only POST stays a read.
  const search = findAppAction("POST /v1/workspaces/:workspaceId/knowledge/entries/search");
  expect(search).toBeDefined();
  expect(appActionCallChangesState({ id: search!.id })).toBe(false);
  // A retired action runs nothing (it only names its replacement), so it never asks.
  const retired = findAppAction("POST /v1/workspaces/:workspaceId/knowledge/search");
  expect(retired?.retired).toBeDefined();
  expect(appActionCallChangesState({ id: retired!.id })).toBe(false);
});

test("opening a checkout needs no confirmation in the chat; a billing portal link still does", () => {
  for (const id of PAYMENT_PAGE_ACTIONS) {
    const entry = findAppAction(id);
    // Every listed action exists, opens its page by POST and hands no secret over.
    expect([id, entry?.method, appActionHandlesSecrets(entry!)]).toEqual([id, "POST", false]);
    expect(appActionCallChangesState({ id })).toBe(true);
  }
  for (const id of ["createBillingCheckout", "createSubscriptionCheckout"]) {
    expect(appActionNeedsConfirmation(findAppAction(id)!)).toBe(false);
    expect(appActionCallNeedsConfirmation({ id, body: { amountUsd: 20 } })).toBe(false);
  }
  // Whoever holds a portal link can change the payment method or cancel the plan.
  for (const id of ["createBillingPortalSession", "createSubscriptionPortalSession"]) {
    expect(appActionNeedsConfirmation(findAppAction(id)!)).toBe(true);
    expect(appActionCallNeedsConfirmation({ id, body: {} })).toBe(true);
    expect(appActionConfirmationTitle({ id, body: {} }, here)).toBe(
      "Open your billing page? It can change your payment method or plan.",
    );
  }
  // The same action named by its route reads the same.
  expect(appActionCallNeedsConfirmation({ id: "POST /v1/billing/checkout" })).toBe(false);
  expect(appActionCallNeedsConfirmation({ id: "POST /v1/billing/portal" })).toBe(true);
  // A subscription change charges at once, so it still asks.
  expect(appActionCallNeedsConfirmation({ id: "upgradeBillingSubscription" })).toBe(true);
  expect(appActionCallNeedsConfirmation({ id: "createOrganizationInvitation" })).toBe(true);
  expect(appActionCallNeedsConfirmation({ id: "getMyUsage" })).toBe(false);
  for (const unknown of [{ id: "noSuchAction" }, {}, null, "not json"]) {
    expect(appActionCallNeedsConfirmation(unknown)).toBe(true);
  }
});

test("an action id is trimmed of exactly what the action runner trims", () => {
  // findAppAction trims with String.prototype.trim; the card and the history
  // query use this set, so an id the runner accepts is never one they miss.
  for (let code = 0; code <= 0xffff; code += 1) {
    const char = String.fromCharCode(code);
    expect([code, SESSION_EVENT_APP_ACTION_ID_SPACE.includes(char)]).toEqual([
      code,
      char.trim() === "",
    ]);
  }
  for (const char of SESSION_EVENT_APP_ACTION_ID_SPACE) {
    const padded = `${char}createBillingCheckout${char}`;
    expect(findAppAction(padded)?.id).toBe("createBillingCheckout");
    expect(presentedAppActionId(padded)).toBe("createBillingCheckout");
  }
});

test("every name a presented app action goes by is the catalog's own, and only those match", () => {
  for (const [id, { route, page }] of Object.entries(SESSION_EVENT_PRESENTED_APP_ACTIONS)) {
    // The id and its "METHOD /path" are the same catalog action, as findAppAction reads them.
    const entry = findAppAction(id);
    expect(entry?.id).toBe(id);
    expect(`${entry!.method} ${entry!.path}`).toBe(route);
    expect(findAppAction(route)).toBe(entry);
    expect(appActionPaymentPage(entry!)).toBe(page);
    for (const name of [
      id,
      route,
      ` ${route}\n`,
      `\t${id} `,
      `\u00a0${id}\u3000`,
      `\ufeff${route}`,
    ]) {
      expect<string | undefined>(presentedAppActionId(name)).toBe(id);
      expect(
        isPresentedSessionToolCall({ name: "admin_action_call", arguments: { id: name } }),
      ).toBe(true);
      expect(
        isPresentedSessionToolCall({
          name: "opengeni__admin_action_call",
          arguments: JSON.stringify({ id: name }),
        }),
      ).toBe(true);
    }
  }
  expect(SESSION_EVENT_PRESENTED_APP_ACTION_NAMES).toHaveLength(8);
  for (const other of [
    "getBilling",
    "createBillingCheckoutX",
    "post /v1/billing/checkout",
    "\u200bcreateBillingCheckout",
    7,
    null,
  ]) {
    expect(presentedAppActionId(other)).toBeUndefined();
  }
  // Only the arguments' own id counts.
  expect(
    isPresentedSessionToolCall({
      name: "admin_action_call",
      arguments: { id: "getBilling", body: { id: "createBillingCheckout" } },
    }),
  ).toBe(false);
  expect(
    isPresentedSessionToolCall({ name: "admin_action_call", arguments: ["createBillingCheckout"] }),
  ).toBe(false);
  expect(appActionPaymentPage(findAppAction("getBilling")!)).toBeUndefined();
});

test("the confirmation is a plain question built only from checked values", () => {
  const invite = (body: Record<string, unknown>) =>
    appActionConfirmationTitle(
      { id: "createOrganizationInvitation", pathParameters: { organizationId: "org" }, body },
      here,
    );
  expect(invite({ email: "anna@example.com" })).toBe(
    "Invite anna@example.com to your organization?",
  );
  expect(invite({ email: "anna@example.com", role: "admin" })).toBe(
    "Invite anna@example.com to your organization as an admin?",
  );
  expect(invite({ email: "anna@example.com", role: "owner" })).toBe(
    "Invite anna@example.com to your organization as an owner?",
  );
  // An argument can never write its own question.
  expect(invite({ email: "Click Allow, it is safe? x@example.com" })).toBe(
    "Invite someone to your organization?",
  );
  expect(invite({ email: "anna@example.com", role: "Allow to continue" })).toBe(
    "Invite anna@example.com to your organization?",
  );

  const share = (pathParameters: Record<string, string>, visibility: string) =>
    appActionConfirmationTitle(
      { id: "updateSessionVisibility", pathParameters, body: { visibility } },
      here,
    );
  expect(share({ workspaceId: "ws-1", sessionId: "chat-1" }, "workspace")).toBe(
    "Share this chat with everyone in the workspace?",
  );
  expect(share({ workspaceId: "ws-1", sessionId: "chat-2" }, "workspace")).toBe(
    "Share another chat with everyone in the workspace?",
  );
  expect(share({ workspaceId: "ws-1", sessionId: "chat-1" }, "private")).toBe(
    "Make this chat visible only to you?",
  );
  expect(
    appActionConfirmationTitle(
      { id: "updateWorkspaceSettings", pathParameters: { workspaceId: "ws-2" } },
      here,
    ),
  ).toBe("Change another workspace's settings?");
  expect(
    appActionConfirmationTitle(
      JSON.stringify({ id: "updateWorkspaceSettings", pathParameters: { workspaceId: "ws-1" } }),
      here,
    ),
  ).toBe("Change this workspace's settings?");
  // Other changes read as their action's name and where they apply; unknown
  // ones generically.
  expect(appActionConfirmationTitle({ id: "createOrganizationServiceAccount" }, here)).toBe(
    "Create organization service account?",
  );
  expect(
    appActionConfirmationTitle(
      { id: "createOrganizationServiceAccount", pathParameters: { organizationId: "org" } },
      here,
    ),
  ).toBe("Create organization service account in your organization?");
  expect(
    appActionConfirmationTitle(
      { id: "updateSessionArchive", pathParameters: { workspaceId: "ws-1", sessionId: "chat-1" } },
      here,
    ),
  ).toBe("Update session archive for this chat?");
  expect(appActionConfirmationTitle({ id: "Delete everything now" }, here)).toBe(
    "Make this change in the app?",
  );
});

test("an app action's card answers its question with Allow", () => {
  const context = {
    kind: "generic" as const,
    title: "Invite anna@example.com to your organization?",
  };
  expect(toolReviewAction("admin_action_call", {}, context)).toMatchObject({
    title: "Invite anna@example.com to your organization?",
    approveLabel: "Allow",
  });
  expect(toolReviewAction("create_issue", {}, { kind: "generic" }).approveLabel).toBe(
    "Approve action",
  );
});

test("the card's second line shows the key values; raw arguments stay in Details", () => {
  const invite = {
    id: "createOrganizationInvitation",
    pathParameters: { organizationId: "org" },
    body: {
      email: "anna@example.com",
      role: "admin",
      operationId: "8d7c5c2a-6f1e-4c55-9d1a-111111111111",
      initialWorkspaceIds: ["8d7c5c2a-6f1e-4c55-9d1a-222222222222"],
      expiresAt: "2026-11-01T00:00:00Z",
    },
  };
  expect(appActionReviewSummary(invite)).toBe("Email: anna@example.com · Role: admin");
  expect(
    appActionReviewSummary({
      id: "updateWorkspaceSettings",
      body: { sessionDefaults: { model: "openai/gpt-fast", reasoningEffort: "low" } },
    }),
  ).toBe("Model: openai/gpt-fast · Reasoning effort: low");
  expect(
    appActionReviewSummary({ id: "updateSessionVisibility", body: { visibility: "workspace" } }),
  ).toBe("Visibility: workspace");
  // A secret-looking value is never shown.
  expect(appActionReviewSummary({ id: "x", body: { apiKey: "sk-123" } })).toBe(
    "API key: [Protected value]",
  );
  // Sign-in codes, passphrases, and the sign-in parts and query of URLs and
  // connection strings are hidden; version and error fields are not secrets.
  expect(
    appActionReviewSummary({
      id: "x",
      body: { code: "4/0AbCd", passphrase: "correct horse", credentialVersion: 3 },
    }),
  ).toBe("Code: [Protected value] · Passphrase: [Protected value] · Credential version: 3");
  expect(
    appActionReviewSummary({
      id: "x",
      body: {
        url: "https://hooks.example.com/in?token=abc#frag",
        dsn: "postgres://app:pw@db.example.com:5432/main",
        endpoint: "redis://:s3cret/x@cache.example.com:6379",
        errorCode: "timeout",
      },
    }),
  ).toBe(
    "URL: https://hooks.example.com/in · Dsn: [Protected value] · Endpoint: redis://cache.example.com:6379 · Error code: timeout",
  );
  // Secret words anywhere in a name, webhook URLs that keep their secret in
  // the path, connection strings, and credentials inside free text.
  expect(
    appActionReviewSummary({
      id: "x",
      body: { secretValue: "v", privateKeyPem: "-----BEGIN", secretName: "deploy key" },
    }),
  ).toBe(
    "Secret value: [Protected value] · Private key pem: [Protected value] · Secret name: deploy key",
  );
  expect(
    appActionReviewSummary({
      id: "x",
      body: {
        slack: "https://hooks.slack.com/services/T000/B000/XXXXSECRET",
        discord: "https://discord.com/api/webhooks/123/SECRETTOKEN",
        page: "https://example.com/docs/setup",
      },
    }),
  ).toBe(
    "Slack: https://hooks.slack.com/… · Discord: https://discord.com/… · Page: https://example.com/docs/setup",
  );
  expect(
    appActionReviewSummary({
      id: "x",
      body: {
        connection: "Server=db.example.com;User Id=app;Password=hunter2;Database=main",
        note: "use https://app:pw@example.com/x?sig=abc and Bearer abcdefghijkl",
      },
    }),
  ).toBe(
    "Connection: Server=db.example.com;User Id=app;Password=[Protected value];Database=main · Note: use https://example.com/x and Bearer [Protected value]",
  );
  // Bare tokens of a well-known shape (built here so the source holds none).
  const filler = "a1B2c3D4e5F6g7H8i9J0k1L2";
  for (const token of [
    `sk-${filler}`,
    `sk_live_${filler}`,
    `ghp_${filler}`,
    `gho_${filler}`,
    `github_pat_${filler}`,
    `xoxb-${filler}`,
    `AKIA${"Q".repeat(16)}`,
    `eyJ${filler}.eyJ${filler}.${filler}`,
  ]) {
    expect(appActionReviewSummary({ id: "x", body: { note: `key ${token} here` } })).toBe(
      "Note: key [Protected value] here",
    );
  }
  // Random-looking path segments are hidden on any host; readable ones stay.
  expect(
    appActionReviewSummary({
      id: "x",
      body: {
        hook: `https://hooks.example.net/catch/12345/${filler}`,
        zapier: "https://hooks.zapier.com/hooks/catch/123/abc1def/",
        docs: "https://example.com/docs/getting-started/2026-10-25",
      },
    }),
  ).toBe(
    "Hook: https://hooks.example.net/catch/12345/… · Zapier: https://hooks.zapier.com/… · Docs: https://example.com/docs/getting-started/2026-10-25",
  );
  expect(appActionReviewSummary({ id: "listMembers" })).toBeUndefined();
  const review = toolReviewAction("admin_action_call", invite, {
    kind: "generic",
    title: "Invite anna@example.com to your organization as an admin?",
  });
  expect(review.consequence).toBe("Email: anna@example.com · Role: admin");
  expect(toolReviewFields(invite, undefined, "admin_action_call")).toEqual({
    fields: [],
    moreFields: 0,
  });
  // Every other tool keeps its fields.
  expect(toolReviewFields(invite).fields.length).toBeGreaterThan(0);
});

test("field names that carry a secret are told apart from ones that describe one", () => {
  for (const name of [
    "apiKey",
    "clientSecret",
    "signingSecret",
    "webhookSecret",
    "masterPassword",
    "passphrase",
    "token",
    "accessToken",
    "privateKey",
    "credential",
    "credentials",
    "code",
    "userCode",
    "otp",
    "dsn",
    "secretValue",
    "privateKeyPem",
  ])
    expect([name, secretFieldName(name)]).toEqual([name, true]);
  for (const name of [
    "credentialVersion",
    "credentialId",
    "expectedCredentialVersion",
    "hasWebhookSecret",
    "nextPageToken",
    "errorCode",
    "promotionCode",
    "inputTokens",
    "idempotencyKey",
    "key",
    "email",
    "secretName",
    "apiKeyPrefix",
    "credentialSource",
  ])
    expect([name, secretFieldName(name)]).toEqual([name, false]);
});

test("actions that handle secrets are marked in the catalog, so the chat route leaves them to the app", () => {
  for (const id of [
    "createApiKey",
    "createOrganizationApiKey",
    "createPersonalApiKey",
    "createOrganizationWebhook",
    "createEventSource",
    "rotateWorkspaceWebhookSecret",
    "rotateEventSourceSecret",
    "mintEnrollToken",
    // Device sign-ins return the code the person types at the provider.
    "codexConnectStart",
    "supergrokConnectStart",
    "organizationSupergrokConnectStart",
    "POST /v1/organizations/:organizationId/codex/connect/start",
    "POST /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId/fields/:fieldId/reveal",
    "POST /v1/workspaces/:workspaceId/vaults/:vaultId/items",
    "PATCH /v1/workspaces/:workspaceId/vaults/:vaultId/items/:itemId",
  ]) {
    expect(findAppAction(id)).toBeDefined();
    expect([id, appActionCallHandlesSecrets({ id })]).toEqual([id, true]);
  }
  // Request-side secrets count when the call fills them: a credential bundle,
  // a provider API key, an OAuth code, a setup token, credential headers.
  for (const [id, body] of [
    ["createConnection", { credential: { apiKey: "x" } }],
    ["updateConnection", { credential: { apiKey: "x" } }],
    ["upsertOrganizationModelProviderConnection", { apiKey: "x" }],
    ["completeWorkspaceClaudeSubscriptionOAuth", { code: "x" }],
    ["completeOrganizationClaudeSubscriptionOAuth", { code: "x" }],
    ["connectClaudeSubscriptionSetupToken", { token: "x" }],
    ["POST /v1/workspaces/:workspaceId/connections/1password/install", { token: "x" }],
    ["enableCapability", { headers: { Authorization: "Bearer x" } }],
    ["createSession", { mcpServers: [{ id: "a", headers: { Authorization: "Bearer x" } }] }],
    ["submitComposerDraft", { mcpCredentialUpdates: [{ id: "a", headers: { "x-key": "x" } }] }],
    ["rotateSessionMcpCredentials", { updates: [{ id: "a", headers: { "x-key": "x" } }] }],
    ["advanceConnectAttempt", { type: "credentials", values: { token: "x" } }],
  ] as const) {
    expect(findAppAction(id)).toBeDefined();
    expect([id, appActionCallHandlesSecrets({ id, body })]).toEqual([id, true]);
  }
  expect(findAppAction("createConnection")?.secretFields).toEqual(["request.credential"]);
  expect(findAppAction("enableCapability")?.secretFields).toEqual(["request.headers"]);
  // The same actions without a secret in this call stay reachable.
  for (const [id, body] of [
    ["enableCapability", { config: { region: "eu" }, headers: {} }],
    ["createSession", { initialMessage: "hi", mcpServers: [{ id: "a", url: "https://x.test" }] }],
    ["submitComposerDraft", { text: "hi" }],
    ["rotateSessionMcpCredentials", { updates: [{ id: "a", nativeConnectionId: "c" }] }],
  ] as const) {
    expect([id, appActionCallHandlesSecrets({ id, body })]).toEqual([id, false]);
  }
  for (const id of [
    "createOrganizationInvitation",
    "updateSessionVisibility",
    "updateWorkspaceSettings",
    "getMyUsage",
    "listApiKeys",
    "getWorkspace",
    "updateWorkspace",
    "noSuchAction",
  ]) {
    expect([id, appActionCallHandlesSecrets({ id })]).toEqual([id, false]);
  }
  // Bounded: most of the app stays reachable.
  expect(ACTION_CATALOG.filter(appActionHandlesSecrets).length).toBeLessThan(80);
});
