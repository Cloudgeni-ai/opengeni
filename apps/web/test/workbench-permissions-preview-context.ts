import { useSyncExternalStore } from "react";
import type {
  KnowledgeEntryListRequest,
  KnowledgeEntrySummary,
  KnowledgeEntryRecord,
} from "@opengeni/sdk";
import type { AppContextValue } from "../src/context";
import { managedSelfContextIdentity } from "../src/lib/managed-self-context";

export const workspaceId = "22222222-2222-4222-8222-222222222222";
const accountId = "11111111-1111-4111-8111-111111111111";
const personalWorkspaceId = "33333333-3333-4333-8333-333333333333";
export const rigId = "77777777-7777-4777-8777-777777777777";
export const readerPermissions = [
  "workspace:read",
  "sessions:create",
  "sessions:read",
  "sessions:control",
  "files:read",
  "files:write",
  "artifacts:read",
  "documents:search",
  "stream:view",
  "stream:acknowledge",
  "terminal:attach",
];
export type PreviewRole = "reader" | "manager" | "rigs" | "machines" | "failure";
const listeners = new Set<() => void>();
let role: PreviewRole = "reader";
const requests: { method: string; request?: unknown }[] = [];
const violations: string[] = [];
const stamp = "2026-10-18T18:00:00.000Z";
function entry(id: string, title: string, outcome: "published" | "pending"): KnowledgeEntrySummary {
  return {
    id,
    scope: "workspace",
    version: 1,
    publishedRevisionId: outcome === "published" ? id : null,
    latestRevisionId: id,
    archived: false,
    createdAt: stamp,
    updatedAt: stamp,
    excerpts: [],
    revision: {
      id,
      entryId: id,
      number: 1,
      change: "upsert",
      previousRevisionId: null,
      restoredFromRevisionId: null,
      createdAt: stamp,
      createdBySessionId: null,
      reviewBatchId: outcome === "pending" ? "batch" : null,
      outcome,
      title,
      kind: "decision",
      preview: "Keep the existing authorization checks and verify the release before promotion.",
      groupIds: [],
      sourceKind: null,
    },
  };
}
const published = entry(
  "44444444-4444-4444-8444-444444444444",
  "Release verification runbook",
  "published",
);
const pending = entry(
  "55555555-5555-4555-8555-555555555555",
  "Proposed support handoff",
  "pending",
);
function permissions() {
  return [
    ...readerPermissions,
    ...(role === "manager"
      ? ["documents:manage", "rigs:use", "enrollments:read"]
      : role === "rigs" || role === "failure"
        ? ["rigs:use"]
        : role === "machines"
          ? ["enrollments:read"]
          : []),
  ];
}
function record(method: string, permission: string, request?: unknown) {
  requests.push({ method, request });
  if (!permissions().includes(permission)) {
    violations.push(`${method}:${permission}`);
    throw new Error(`Unauthorized fixture request: ${method}`);
  }
}
const rig = {
  id: rigId,
  workspaceId: personalWorkspaceId,
  accountId,
  scope: "user",
  status: "active",
  name: "Personal development rig",
};
const client = {
  async getKnowledgeEntry(_workspace: string, id: string): Promise<KnowledgeEntryRecord> {
    record("knowledge-entry", "documents:search");
    if (id !== published.id) throw new Error("Unknown sample entry");
    return {
      ...published,
      revision: {
        ...published.revision,
        entry: {
          title: published.revision.title,
          kind: "decision",
          content:
            "Published knowledge remains readable without review or resource-management authority.",
          groupIds: [],
          evidence: [],
          relationships: [],
          source: { kind: "manual" },
        },
      },
    };
  },
  async listKnowledgeEntries(_id: string, request: KnowledgeEntryListRequest) {
    record(
      "knowledge",
      request.view === "needs_review" ? "documents:manage" : "documents:search",
      request,
    );
    const entries = request.view === "needs_review" ? [pending] : [published];
    return {
      entries: entries.filter(
        (item) =>
          !request.query || item.revision.title.toLowerCase().includes(request.query.toLowerCase()),
      ),
      nextCursor: null,
    };
  },
  async listKnowledgeReviewBatches() {
    record("review-groups", "documents:manage");
    return { batches: [{ id: "batch", title: "Sample agent proposals" }], nextCursor: null };
  },
  async listAgentInstructionReviews() {
    record("instruction-reviews", "workspace:admin");
    return { entries: [], nextCursor: null };
  },
  async listWorkspaceSkills() {
    record("skills", "workspace:read");
    return { skills: [], nextCursor: null };
  },
  async getAgentLearningSettings() {
    record("learning", "workspace:read");
    return {
      version: 1,
      settings: { knowledge: "review_first", instructions: "review_first", skills: "review_first" },
    };
  },
  async getWorkspaceState() {
    record("workspace-state", "workspace:read");
    return { policy: { activeHeads: [], legacyRuntime: { workspaceOverrideConfigured: false } } };
  },
  async listRigs() {
    record("rigs", "rigs:use");
    if (role === "failure") throw new Error("Fixture rig service unavailable");
    return [rig];
  },
  async getRig() {
    record("rig", "rigs:use");
    return rig;
  },
  async listUserResourceAuthorities(_id: string, request: { resourceKind: string }) {
    record(
      `authority:${request.resourceKind}`,
      request.resourceKind === "rig" ? "rigs:use" : "enrollments:read",
    );
    return {
      authorities: [
        {
          authorityId: "authority",
          resourceKind: request.resourceKind,
          resourceId: rigId,
          originWorkspaceId: personalWorkspaceId,
          generation: 1,
          status: "active",
          grants: [],
        },
      ],
      nextCursor: null,
    };
  },
};
const authSession = {
  session: { id: "sample-cookie", userId: "owner", expiresAt: "2027-01-01T00:00:00Z" },
  user: { id: "owner", name: "Sample reader", email: "sample@example.invalid" },
};
const managedSelfContext = {
  identity: managedSelfContextIdentity({ credentialGeneration: 1, managedUserId: "owner" }),
  memberships: [
    { id: "sample-membership", organizationId: accountId, status: "active", personalWorkspaceId },
  ],
};
function makeContext() {
  return {
    client,
    authSession,
    managedSelfContext,
    accessContext: {
      mode: "managed",
      subjectId: "user:owner",
      accountGrants: [],
      workspaceGrants: [{ workspaceId, permissions: permissions() }],
    },
    workspaces: [{ id: workspaceId, accountId, name: "Sample workspace", kind: "shared" }],
    clientConfig: { auth: { mode: "managedSession" }, fileUploads: { enabled: false } },
    captureWorkspaceInvocation: () => ({}),
    ownsWorkspaceInvocation: () => true,
    resetSessionView: () => undefined,
  } as unknown as AppContextValue;
}
let context = makeContext();
export function useAppContext() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => context,
  );
}
declare global {
  interface Window {
    permissionPreview: {
      requests: typeof requests;
      violations: string[];
      setRole: (next: PreviewRole) => void;
      resourceState?: { rigs: number; machines: number; blocked: boolean };
    };
  }
}
window.permissionPreview = {
  requests,
  violations,
  setRole(next) {
    role = next;
    context = makeContext();
    listeners.forEach((listener) => listener());
  },
};
