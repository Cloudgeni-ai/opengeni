// The SDK's hand-written model-account settings types mirror the
// `@opengeni/contracts` schemas in both directions.
import { expect, test } from "bun:test";
import {
  ModelAccountSettingsOverview as ContractOverview,
  OrganizationModelAccountSettings as ContractOrganization,
  UpdateOrganizationModelAccountSettingsRequest as ContractUpdateOrganization,
  UpdateWorkspaceModelAccountSettingsRequest as ContractUpdateWorkspace,
  WorkspaceModelAccountSettings as ContractWorkspace,
} from "@opengeni/contracts";
import type { z } from "zod";
import type {
  ModelAccountSettingsOverview,
  OrganizationModelAccountSettings,
  UpdateOrganizationModelAccountSettingsRequest,
  UpdateWorkspaceModelAccountSettingsRequest,
  WorkspaceModelAccountSettings,
} from "../src/types";

test("model-account settings responses and requests are parity-pinned", () => {
  // Server -> client: what the API returns is what the SDK declares.
  const organization = (
    v: z.infer<typeof ContractOrganization>,
  ): OrganizationModelAccountSettings => v;
  const workspace = (v: z.infer<typeof ContractWorkspace>): WorkspaceModelAccountSettings => v;
  const overview = (v: z.infer<typeof ContractOverview>): ModelAccountSettingsOverview => v;
  // Client -> server: every SDK request is a valid contract input.
  const updateOrganization = (
    v: UpdateOrganizationModelAccountSettingsRequest,
  ): z.input<typeof ContractUpdateOrganization> => v;
  const updateWorkspace = (
    v: UpdateWorkspaceModelAccountSettingsRequest,
  ): z.input<typeof ContractUpdateWorkspace> => v;
  const values = {
    rotation: { codex: { mode: "spread" as const } },
    providers: {},
    crossProviderFailover: false,
    fallbackOrder: { "codex/a": ["claude/b"] },
    personalConnectionsAllowed: true,
    personalFallbackAllowed: false,
  };
  const org = ContractOrganization.parse({
    organizationId: "o",
    values,
    locked: ["crossProviderFailover"],
    version: 2,
    updatedAt: null,
  });
  expect(organization(org).locked).toEqual(["crossProviderFailover"]);
  const view = {
    values,
    sources: {
      rotation: "organization",
      providers: "organization",
      crossProviderFailover: "locked",
      fallbackOrder: "workspace",
      personalConnectionsAllowed: "organization",
      personalFallbackAllowed: "organization",
    },
    entrySources: { rotation: { codex: "organization" }, providers: {}, fallbackOrder: {} },
  };
  expect(
    workspace(
      ContractWorkspace.parse({
        ...view,
        workspaceId: "w",
        locked: [],
        overrides: {
          rotation: null,
          providers: null,
          crossProviderFailover: null,
          fallbackOrder: { "codex/a": ["claude/b"] },
          personalConnectionsAllowed: null,
          personalFallbackAllowed: null,
        },
        version: 1,
        updatedAt: null,
        canEdit: true,
      }),
    ).canEdit,
  ).toBe(true);
  expect(
    overview(
      ContractOverview.parse({
        organization: org,
        workspaces: [{ ...view, workspaceId: "w", name: "Alpha" }],
        nextCursor: null,
      }),
    ).workspaces,
  ).toHaveLength(1);
  expect(
    ContractUpdateOrganization.parse(
      updateOrganization({ locked: ["rotation"], rotation: { codex: { mode: "primary_first" } } }),
    ).locked,
  ).toEqual(["rotation"]);
  expect(
    ContractUpdateWorkspace.parse(
      updateWorkspace({ fallbackOrder: { "codex/a": null }, crossProviderFailover: null }),
    ).fallbackOrder,
  ).toEqual({ "codex/a": null });
  // Strict bodies: an unknown setting is refused rather than ignored.
  expect(ContractUpdateWorkspace.safeParse({ locked: ["rotation"] }).success).toBe(false);
  expect(ContractUpdateOrganization.safeParse({ locked: ["models"] }).success).toBe(false);
  // An own `__proto__` key (as JSON.parse produces from a request body).
  const prototypeKey = JSON.parse('{"rotation":{"__proto__":{"mode":"spread"}}}');
  const parsedPrototype = ContractUpdateOrganization.parse(prototypeKey);
  expect(Object.keys(parsedPrototype.rotation ?? {})).toEqual([]);
});
