import type {
  SessionArchiveApplyRequest,
  SessionArchiveApplyResponse,
  SessionArchiveBlocker,
  SessionArchivePlanRequest,
  SessionArchivePlanResponse,
  SessionArchiveProjection,
} from "@opengeni/sdk";
import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { OpenGeniProvider, SessionArchiveBanner, SessionArchiveDialog } from "../src/index";
import { MockOpenGeniClient } from "./mock";
import "./styles.css";

const WORKSPACE_ID = "11111111-2222-4333-8444-555555555555";
const ROOT_SESSION_ID = "22222222-2222-4222-8222-222222222222";
const CHILD_SESSION_ID = "33333333-3333-4333-8333-333333333333";
const ARCHIVE_SEAL_ID = "44444444-4444-4444-8444-444444444444";
const ARCHIVE_RECEIPT_ID = "55555555-5555-4555-8555-555555555555";
const MANIFEST_CHECKSUM = `sha256:${"a".repeat(64)}`;
const ROOT_CHECKSUM = `sha256:${"b".repeat(64)}`;
const COVERAGE_CHECKSUM = `sha256:${"c".repeat(64)}`;
const REQUEST_HASH = `sha256:${"d".repeat(64)}`;
const PRECONDITION_CHECKSUM = `sha256:${"e".repeat(64)}`;

const params = new URLSearchParams(window.location.search);
const action = params.get("action") === "unarchive" ? "unarchive" : "archive";
const blocked = params.get("state") === "blocked";
const theme = params.get("theme") === "light" ? "light" : "dark";

function blockers(): SessionArchiveBlocker[] {
  if (!blocked) return [];
  return Array.from({ length: 24 }, (_, index) => ({
    code: index % 2 === 0 ? "goal_active" : "sandbox_lease_exclusive",
    sessionId: index % 2 === 0 ? ROOT_SESSION_ID : CHILD_SESSION_ID,
    resourceId: `blocked-resource-${index + 1}`,
    state: index % 2 === 0 ? "active" : "warm",
    details: {},
  }));
}

function archivedProjection(): SessionArchiveProjection {
  return {
    archived: true,
    archiveRevision: "8",
    activeSealCount: 1,
    archivedAt: "2026-07-19T00:00:00.000Z",
    nearestFence: {
      sessionId: ROOT_SESSION_ID,
      rootSessionId: ROOT_SESSION_ID,
      sealId: ARCHIVE_SEAL_ID,
      archiveRevision: "8",
    },
  };
}

const liveProjection: SessionArchiveProjection = {
  archived: false,
  archiveRevision: "9",
  activeSealCount: 0,
  archivedAt: null,
  nearestFence: null,
};

class ArchiveHarnessClient extends MockOpenGeniClient {
  async planSessionArchive(
    workspaceId: string,
    request: SessionArchivePlanRequest,
  ): Promise<SessionArchivePlanResponse> {
    const root = request.roots[0]!;
    const targetSealId = request.action === "unarchive" ? root.targetSealId! : null;
    const currentBlockers = blockers();
    const canApply = currentBlockers.length === 0;
    return {
      manifest: {
        format: "opengeni.session-archive-manifest",
        version: 1,
        workspaceId,
        action: request.action,
        totalMemberCount: 2,
        roots: [
          {
            rootSessionId: root.rootSessionId,
            targetSealId,
            memberCount: 2,
            members: [
              {
                sessionId: ROOT_SESSION_ID,
                parentSessionId: null,
                depth: 0,
                expectedArchiveRevision: "7",
                expectedArchived: request.action === "unarchive",
              },
              {
                sessionId: CHILD_SESSION_ID,
                parentSessionId: ROOT_SESSION_ID,
                depth: 1,
                expectedArchiveRevision: "3",
                expectedArchived: request.action === "unarchive",
              },
            ],
          },
        ],
      },
      manifestChecksum: MANIFEST_CHECKSUM,
      canApply,
      roots: [
        {
          rootSessionId: root.rootSessionId,
          targetSealId,
          rootChecksum: ROOT_CHECKSUM,
          memberCount: 2,
          canApply,
          blockers: currentBlockers,
        },
      ],
    };
  }

  async applySessionArchive(
    workspaceId: string,
    request: SessionArchiveApplyRequest,
  ): Promise<SessionArchiveApplyResponse> {
    const applyAction = request.manifest!.action;
    const targetSealId = request.manifest!.roots[0]!.targetSealId;
    const sealId = applyAction === "archive" ? ARCHIVE_SEAL_ID : targetSealId!;
    return {
      receipt: {
        id: ARCHIVE_RECEIPT_ID,
        workspaceId,
        action: applyAction,
        operationKey: request.idempotencyKey,
        idempotencyKey: request.idempotencyKey,
        requestHash: REQUEST_HASH,
        authority: {
          actorSubjectId: "operator:authenticated-caller",
          grantSubjectId: "operator:archive-grant",
          grantAuthority: "workspace:admin",
        },
        manifestChecksum: request.manifestChecksum,
        rootChecksum: request.rootChecksum,
        rootSessionId: request.rootSessionId,
        targetSealId,
        resultingSealId: applyAction === "archive" ? sealId : null,
        sealId,
        memberCount: 2,
        precondition: {
          blockerCount: 0,
          memberCount: 2,
          checksum: PRECONDITION_CHECKSUM,
        },
        coverageChecksum: COVERAGE_CHECKSUM,
        committedAt: "2026-07-19T00:00:01.000Z",
      },
      replay: false,
      rootArchive: applyAction === "archive" ? archivedProjection() : liveProjection,
    };
  }
}

function Harness() {
  const client = useMemo(() => new ArchiveHarnessClient(), []);
  const [open, setOpen] = useState(false);
  const [projection, setProjection] = useState<SessionArchiveProjection | null>(() =>
    action === "unarchive" ? archivedProjection() : null,
  );

  return (
    <OpenGeniProvider client={client} workspaceId={WORKSPACE_ID}>
      <div
        className="og-root min-h-dvh bg-og-bg text-og-fg"
        data-og-theme={theme === "light" ? "light" : undefined}
      >
        <SessionArchiveBanner archive={projection} />
        <main className="mx-auto flex min-h-dvh max-w-3xl items-center px-4 py-12 sm:px-8">
          <section className="w-full rounded-og-lg border border-og-border bg-og-surface-1 p-5 shadow-og-sm sm:p-8">
            <p className="text-og-xs font-medium uppercase tracking-wide text-og-fg-subtle">
              Historical session tree
            </p>
            <h1 className="mt-2 text-og-lg font-semibold text-og-fg">
              Quarterly infrastructure audit
            </h1>
            <p className="mt-2 max-w-xl text-og-sm leading-6 text-og-fg-muted">
              Review an exact recursive plan before changing the audited execution fence. Durable
              history and lineage stay available in every state.
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="mt-5 min-h-11 rounded-og-sm bg-og-accent px-4 py-2 text-og-sm font-semibold text-og-accent-fg"
            >
              Review {action}
            </button>
          </section>
        </main>
        {action === "archive" ? (
          <SessionArchiveDialog
            action="archive"
            sessionId={ROOT_SESSION_ID}
            sessionTitle="Quarterly infrastructure audit"
            open={open}
            onOpenChange={setOpen}
            onApplied={(response) => setProjection(response.rootArchive)}
          />
        ) : (
          <SessionArchiveDialog
            action="unarchive"
            targetSealId={ARCHIVE_SEAL_ID}
            sessionId={ROOT_SESSION_ID}
            sessionTitle="Quarterly infrastructure audit"
            open={open}
            onOpenChange={setOpen}
            onApplied={(response) => setProjection(response.rootArchive)}
          />
        )}
      </div>
    </OpenGeniProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Harness />);
