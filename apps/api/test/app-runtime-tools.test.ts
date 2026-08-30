import { describe, expect, test } from "bun:test";
import { MemoryEventBus, testSettings } from "@opengeni/testing";
import { digestCanonicalJson } from "@opengeni/tool-runtime";
import type { ApiRouteDeps, AppCurrentHumanAuthority } from "@opengeni/core";

import { createCurrentHumanAppRuntimeToolProvider } from "../src/app-runtime-tools";

const accountId = crypto.randomUUID();
const workspaceId = crypto.randomUUID();
const appId = crypto.randomUUID();
const releaseId = crypto.randomUUID();

function deps(): ApiRouteDeps {
  return {
    settings: testSettings({ sandboxSelfhostedEnabled: true }),
    db: {},
    bus: new MemoryEventBus(),
    workflowClient: {},
    objectStorage: null,
    githubStateSecret: "test-state-secret",
    documentIndexer: { indexDocument: async () => undefined },
    getDocumentServices: () => {
      throw new Error("document services not used");
    },
    resumeBoxById: async () => {
      throw new Error("resumeBoxById not used");
    },
  } as ApiRouteDeps;
}

const authority: AppCurrentHumanAuthority = Object.freeze({
  accountId,
  workspaceId,
  subjectId: "human:app-runtime-test",
  principalKind: "human_session",
  canonicalManagedHumanSession: true,
  canonicalLocalHumanSession: false,
  permissions: Object.freeze([
    "apps:run",
    "sessions:read",
    "connections:read",
    "rigs:use",
    "github:use",
    "variable-sets:list",
    "secrets:list",
    "scheduled_tasks:run",
  ]),
  sourceSessionId: null,
  sourceTurnId: null,
  sourceAttemptId: null,
  sourceExecutionGeneration: null,
  managedActorEpoch: "actor:1",
  managedSessionSetAuthorityHash: "authority:1",
  currentHuman: true,
});

describe("current-human App runtime tools", () => {
  test("publishes only explicit closed-world replay-safe reads", async () => {
    const provider = createCurrentHumanAppRuntimeToolProvider(deps);
    const resolved = await provider.resolve({ authority, appId, releaseId });
    const descriptors = resolved.bindings.map((binding) => binding.descriptor);
    const names = descriptors.map((descriptor) => descriptor.identity.toolName);

    expect(names).toContain("sessions_list");
    expect(names).toContain("session_get");
    expect(names).toContain("slack_bot_list_channels");
    expect(names).not.toContain("session_create");
    expect(names).not.toContain("slack_bot_post_message");
    expect(names).not.toContain("slack_bot_delete_message");
    expect(names).not.toContain("social_search_live");
    expect(names).not.toContain("x_search_live");
    expect(
      descriptors.every(
        (descriptor) =>
          descriptor.effect === "read" &&
          descriptor.replaySafety === "safe" &&
          descriptor.approval === "none" &&
          descriptor.openWorld === false &&
          descriptor.supportedSurfaces.includes("app"),
      ),
    ).toBe(true);
    expect(resolved.catalogDigest).toBe(digestCanonicalJson(descriptors));
  });

  test("rejects invocation after any current-human authority drift", async () => {
    const provider = createCurrentHumanAppRuntimeToolProvider(deps);
    const resolved = await provider.resolve({ authority, appId, releaseId });
    const binding = resolved.bindings.find(
      ({ descriptor }) => descriptor.identity.toolName === "sessions_list",
    );
    expect(binding).toBeDefined();

    await expect(
      binding!.invoke(
        {},
        {
          operationId: crypto.randomUUID(),
          caller: {
            authority: {
              ...authority,
              permissions: authority.permissions.filter(
                (permission) => permission !== "sessions:read",
              ),
            },
            appId,
            releaseId,
          },
        },
      ),
    ).rejects.toThrow("authority changed");
  });
});
