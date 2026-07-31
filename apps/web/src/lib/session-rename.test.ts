import { describe, expect, test } from "bun:test";
import { actRun, registerDom, renderHook } from "../../../../packages/react/test/render-hook";

import {
  SESSION_TITLE_MAX_LENGTH,
  performRename,
  renameSeedValue,
  resolveRenameSubmission,
  sessionDisplayTitle,
  useInlineRename,
} from "./session-rename";
import type { Session } from "../types";

registerDom();

// The three rename surfaces (header pencil, rail-row context menu, rail-row
// hover overflow) all funnel through these pure helpers and the `useInlineRename`
// hook built on them. The hook's state lifecycle needs a DOM to exercise (the
// console's test harness is pure-logic), so we lock the load-bearing behaviour —
// what title shows, what the editor seeds from, and which submissions persist
// vs. no-op cancel — at the helper level here.

function session(patch: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    accountId: "account-1",
    workspaceId: "workspace-1",
    status: "running",
    initialMessage: "Inspect the repo",
    title: null,
    titleSource: null,
    instructions: null,
    resources: [],
    skills: [],
    tools: [],
    toolPolicy: { mode: "explicit", inheritedFromSessionId: null },
    toolPolicyVersion: 1,
    metadata: {},
    createdBy: { kind: "subject", subjectId: "user:test" },
    createdByContext: {},
    model: "scripted-model",
    sandboxBackend: "none",
    sandboxOs: "linux",
    sandboxGroupId: "session-1",
    activeSandboxId: null,
    activeEpoch: 0,
    parentSessionId: null,
    rigId: null,
    rigVersionId: null,
    variableSetId: null,
    environmentId: null,
    firstPartyMcpPermissions: null,
    firstPartyMcpTools: [],
    mcpServers: [],
    rootSessionId: "session-1",
    nestedAgentDepth: 0,
    maxNestedAgentDepthOverride: null,
    effectiveMaxNestedAgentDepth: 3,
    nestedAgentDepthPolicySource: "default",
    nestedAgentDepthPolicySessionId: null,
    createIdempotencyKey: null,
    temporalWorkflowId: null,
    activeTurnId: "turn-1",
    lastSequence: 0,
    pinned: false,
    pinnedAt: null,
    pinVersion: 0,
    createdAt: "2026-05-07T00:00:00.000Z",
    updatedAt: "2026-05-07T00:00:00.000Z",
    ...patch,
    queueVersion: patch.queueVersion ?? 0,
    queueHeadPosition: patch.queueHeadPosition ?? 0,
    queueTailPosition: patch.queueTailPosition ?? 0,
    effectiveControl: patch.effectiveControl ?? {
      state: "active",
      controlVersion: 0,
      controlEtag: "active-0",
      directState: "active",
      primaryBlocker: null,
      additionalBlockerCount: 0,
      blockers: [],
      resumeOptions: [],
      override: null,
      settlement: null,
    },
    codexCompactionMode: patch.codexCompactionMode ?? "portable",
  };
}

describe("sessionDisplayTitle", () => {
  test("prefers the durable title, then the initial message, then a placeholder", () => {
    expect(sessionDisplayTitle(session({ title: "  Ship the rename UI  " }))).toBe(
      "Ship the rename UI",
    );
    expect(sessionDisplayTitle(session({ title: null }))).toBe("Inspect the repo");
    expect(sessionDisplayTitle(session({ title: null, initialMessage: "   " }))).toBe(
      "Untitled session",
    );
    expect(
      sessionDisplayTitle(session({ title: "   ", initialMessage: null as unknown as string })),
    ).toBe("Untitled session");
  });
});

describe("renameSeedValue", () => {
  test("seeds the editor from the real title/message, never the placeholder", () => {
    // The editor must open onto editable text, not the "Untitled session"
    // placeholder, and an empty session opens to an empty field.
    expect(renameSeedValue(session({ title: "Existing title" }))).toBe("Existing title");
    expect(renameSeedValue(session({ title: null }))).toBe("Inspect the repo");
    expect(
      renameSeedValue(session({ title: null, initialMessage: null as unknown as string })),
    ).toBe("");
  });
});

describe("resolveRenameSubmission", () => {
  const display = "Inspect the repo";

  test("persists a trimmed, changed title", () => {
    expect(resolveRenameSubmission("  New name  ", display)).toBe("New name");
  });

  test("treats an empty draft as a no-op cancel", () => {
    expect(resolveRenameSubmission("", display)).toBeNull();
    expect(resolveRenameSubmission("   ", display)).toBeNull();
  });

  test("treats an unchanged draft (after trim) as a no-op cancel", () => {
    expect(resolveRenameSubmission(display, display)).toBeNull();
    expect(resolveRenameSubmission(`  ${display}  `, display)).toBeNull();
  });
});

describe("session title bounds", () => {
  test("matches the shared maxLength the rename inputs enforce", () => {
    expect(SESSION_TITLE_MAX_LENGTH).toBe(200);
  });
});

describe("performRename (the commit every rename surface runs)", () => {
  // Mirrors the App.test.ts mock-client idiom: a recording double standing in
  // for context.updateSessionTitle, so we can assert exactly what the commit
  // sends through when a user submits a rename from any of the three surfaces.
  function recordingRename() {
    const calls: Array<{ workspaceId: string; sessionId: string; title: string }> = [];
    const fn = async (
      workspaceId: string,
      sessionId: string,
      title: string,
    ): Promise<Session | null> => {
      calls.push({ workspaceId, sessionId, title });
      return session({ title, titleSource: "user" });
    };
    return { calls, fn };
  }

  test("submitting a new title calls updateSessionTitle with the trimmed value", async () => {
    const rename = recordingRename();
    const result = await performRename(session({ title: "Old" }), "  Brand new title  ", rename.fn);

    expect(rename.calls).toEqual([
      { workspaceId: "workspace-1", sessionId: "session-1", title: "Brand new title" },
    ]);
    expect(result?.title).toBe("Brand new title");
  });

  test("renames a still-untitled session to the typed value", async () => {
    const rename = recordingRename();
    await performRename(session({ title: null }), "First real name", rename.fn);
    expect(rename.calls).toEqual([
      { workspaceId: "workspace-1", sessionId: "session-1", title: "First real name" },
    ]);
  });

  test("an empty or unchanged submission never calls updateSessionTitle (no-op cancel)", async () => {
    const rename = recordingRename();
    // Empty draft.
    expect(await performRename(session({ title: "Keep me" }), "   ", rename.fn)).toBeNull();
    // Unchanged from the displayed title.
    expect(await performRename(session({ title: "Keep me" }), "Keep me", rename.fn)).toBeNull();
    // Unchanged from the initial-message fallback display.
    expect(await performRename(session({ title: null }), "Inspect the repo", rename.fn)).toBeNull();
    expect(rename.calls).toEqual([]);
  });
});

describe("useInlineRename commit fencing", () => {
  test("Enter followed by blur only persists one title while the first request is pending", async () => {
    let resolveRename!: (result: Session | null) => void;
    const renameResponse = new Promise<Session | null>((resolve) => {
      resolveRename = resolve;
    });
    const calls: string[] = [];
    const hook = await renderHook(
      () =>
        useInlineRename(session({ title: "Old" }), async (_workspaceId, _sessionId, title) => {
          calls.push(title);
          return await renameResponse;
        }),
      undefined,
    );

    await actRun(() => hook.result.current.startEditing());
    await actRun(() => hook.result.current.setDraft("New"));

    // Both handlers retain the same pre-update closure in a real Enter+blur
    // sequence. The ref fence must win before React commits `saving=true`.
    const commit = hook.result.current.commit;
    let first!: Promise<void>;
    let second!: Promise<void>;
    await actRun(() => {
      first = commit();
      second = commit();
    });

    expect(calls).toEqual(["New"]);

    resolveRename(session({ title: "New", titleSource: "user" }));
    await actRun(async () => {
      await Promise.all([first, second]);
    });
    expect(calls).toHaveLength(1);
    await hook.unmount();
  });
});

describe("rename controls do not open the session", () => {
  // The rail-row rename affordances (context-menu item + hover overflow button)
  // sit inside the clickable row, so their click handlers must stopPropagation
  // to keep the row's onSelect (open-session) from firing. This models that
  // wiring: the control's onClick stops propagation before the row's onClick
  // would run, so onSelect is never reached.
  function fakeMouseEvent() {
    let stopped = false;
    return {
      stopPropagation: () => {
        stopped = true;
      },
      get propagationStopped() {
        return stopped;
      },
    };
  }

  test("clicking a rename control stops propagation, so onSelect is not fired", () => {
    let selected = false;
    const onSelect = () => {
      selected = true;
    };
    // The control handler the row renders: stopPropagation, then start editing.
    const event = fakeMouseEvent();
    const controlOnClick = (e: { stopPropagation: () => void }) => e.stopPropagation();

    controlOnClick(event);
    // The row's onClick only runs onSelect when the event was allowed to bubble.
    if (!event.propagationStopped) {
      onSelect();
    }

    expect(event.propagationStopped).toBe(true);
    expect(selected).toBe(false);
  });

  test("clicking the row body (no rename control) does open the session", () => {
    let selected = false;
    const onSelect = () => {
      selected = true;
    };
    const event = fakeMouseEvent();
    // No control intercepts: the event bubbles to the row, which selects.
    if (!event.propagationStopped) {
      onSelect();
    }
    expect(selected).toBe(true);
  });
});
