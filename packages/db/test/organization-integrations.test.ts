import { describe, expect, test } from "bun:test";
import {
  integrationInitiatingHuman,
  integrationWorkspaceFilterMatches,
  organizationWebhookReaches,
  selectWorkspaceCredentialProvider,
} from "../src/workspace-integrations";

describe("organization integration workspace filtering", () => {
  test("only null includes native and external workspaces", () => {
    for (const externalSource of [null, "product", "other"]) {
      expect(integrationWorkspaceFilterMatches(null, { externalSource })).toBe(true);
      expect(integrationWorkspaceFilterMatches({} as never, { externalSource })).toBe(false);
    }
  });
  test("external source matches exactly, never native or another product", () => {
    const filter = { externalSource: "product" };
    expect(integrationWorkspaceFilterMatches(filter, { externalSource: "product" })).toBe(true);
    expect(integrationWorkspaceFilterMatches(filter, { externalSource: null })).toBe(false);
    expect(integrationWorkspaceFilterMatches(filter, { externalSource: "Product" })).toBe(false);
    expect(integrationWorkspaceFilterMatches(filter, { externalSource: "other" })).toBe(false);
  });
});

describe("workspace credential provider precedence", () => {
  const scope = { accountId: "account", workspaceId: "workspace" };
  const workspace = {
    accountId: "account",
    id: "workspace",
    externalSource: "product",
    kind: "shared" as const,
  };
  const provider = { ...scope, enabled: true };
  const organization = {
    accountId: "account",
    enabled: true,
    workspaceFilter: { externalSource: "product" },
    allowPersonalWorkspaces: false,
    allowedWorkspaceIds: null as string[] | null,
  };
  test("enabled workspace wins; disabled workspace opts out; only absence inherits", () => {
    expect(selectWorkspaceCredentialProvider(scope, workspace, provider, organization)).toBe(
      provider,
    );
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        workspace,
        { ...provider, enabled: false },
        organization,
      ),
    ).toBeNull();
    expect(selectWorkspaceCredentialProvider(scope, workspace, null, organization)).toBe(
      organization,
    );
  });
  test("Personal inherits only with the Personal switch, and keeps its own provider", () => {
    const personal = { ...workspace, kind: "personal" as const };
    expect(selectWorkspaceCredentialProvider(scope, personal, null, organization)).toBeNull();
    expect(selectWorkspaceCredentialProvider(scope, personal, provider, organization)).toBe(
      provider,
    );
    const reachesPersonal = { ...organization, allowPersonalWorkspaces: true };
    expect(selectWorkspaceCredentialProvider(scope, personal, null, reachesPersonal)).toBe(
      reachesPersonal,
    );
    // The filter selects shared workspaces only; the switch alone decides Personal.
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        { ...personal, externalSource: null },
        null,
        reachesPersonal,
      ),
    ).toBe(reachesPersonal);
    expect(selectWorkspaceCredentialProvider(scope, personal, provider, reachesPersonal)).toBe(
      provider,
    );
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        personal,
        { ...provider, enabled: false },
        reachesPersonal,
      ),
    ).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(scope, personal, null, {
        ...reachesPersonal,
        enabled: false,
      }),
    ).toBeNull();
  });
  test("the Personal switch never widens shared workspaces", () => {
    expect(
      selectWorkspaceCredentialProvider(scope, { ...workspace, externalSource: "other" }, null, {
        ...organization,
        allowPersonalWorkspaces: true,
      }),
    ).toBeNull();
  });
  test("picked workspaces narrow shared ones on top of the filter, never Personal ones", () => {
    const picked = { ...organization, allowedWorkspaceIds: ["workspace"] };
    expect(selectWorkspaceCredentialProvider(scope, workspace, null, picked)).toBe(picked);
    const elsewhere = { ...organization, allowedWorkspaceIds: ["another"] };
    expect(selectWorkspaceCredentialProvider(scope, workspace, null, elsewhere)).toBeNull();
    // The list and the filter both have to allow it.
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        { ...workspace, externalSource: "other" },
        null,
        picked,
      ),
    ).toBeNull();
    // The Personal switch alone decides Personal workspaces, whatever the list says.
    const personal = { ...workspace, kind: "personal" as const };
    expect(
      selectWorkspaceCredentialProvider(scope, personal, null, {
        ...elsewhere,
        allowPersonalWorkspaces: true,
      }),
    ).not.toBeNull();
    expect(selectWorkspaceCredentialProvider(scope, personal, null, picked)).toBeNull();
  });
  test("organization webhooks follow the list and filter, and never reach Personal workspaces", () => {
    const webhook = { workspaceFilter: null, allowedWorkspaceIds: ["workspace"] };
    expect(organizationWebhookReaches(webhook, workspace)).toBe(true);
    expect(organizationWebhookReaches(webhook, { ...workspace, id: "another" })).toBe(false);
    expect(organizationWebhookReaches({ ...webhook, allowedWorkspaceIds: null }, workspace)).toBe(
      true,
    );
    expect(organizationWebhookReaches(webhook, { ...workspace, kind: "personal" })).toBe(false);
  });
  test("organization must be enabled and match exact source/account", () => {
    expect(
      selectWorkspaceCredentialProvider(scope, workspace, null, {
        ...organization,
        enabled: false,
      }),
    ).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(scope, workspace, null, {
        ...organization,
        workspaceFilter: { externalSource: "other" },
      }),
    ).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(scope, workspace, null, {
        ...organization,
        accountId: "other",
      }),
    ).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        { ...workspace, externalSource: null },
        null,
        organization,
      ),
    ).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(scope, { ...workspace, externalSource: null }, null, {
        ...organization,
        workspaceFilter: null,
      }),
    ).not.toBeNull();
  });
  test("missing/foreign workspace and provider scope cannot resolve", () => {
    expect(selectWorkspaceCredentialProvider(scope, null, provider, organization)).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        { ...workspace, accountId: "other" },
        provider,
        organization,
      ),
    ).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        { ...workspace, id: "other" },
        provider,
        organization,
      ),
    ).toBeNull();
    expect(
      selectWorkspaceCredentialProvider(
        scope,
        workspace,
        { ...provider, accountId: "other" },
        null,
      ),
    ).toBeNull();
  });
});

describe("integration human attribution", () => {
  const externalIdentity = { source: "product", externalId: "alice" };
  test("service is null; native/unmapped humans have null external identity", () => {
    expect(integrationInitiatingHuman(null, externalIdentity)).toBeNull();
    expect(integrationInitiatingHuman("user:alice", externalIdentity)).toEqual({
      subjectId: "user:alice",
      externalIdentity: null,
    });
    expect(integrationInitiatingHuman("external_user:missing", null)).toEqual({
      subjectId: "external_user:missing",
      externalIdentity: null,
    });
  });
  test("only external_user prefix receives resolved external identity", () => {
    expect(integrationInitiatingHuman("external_user:alice", externalIdentity)).toEqual({
      subjectId: "external_user:alice",
      externalIdentity,
    });
    expect(
      integrationInitiatingHuman("user:external_user:alice", externalIdentity)?.externalIdentity,
    ).toBeNull();
  });
});
