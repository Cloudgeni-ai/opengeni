/* ----------------------------------------------------------------------------
   Phase 5 sandbox-surfacing hook tests: capability negotiation drives gated
   rendering; 409 (consent) and 429 (viewer cap) surface as typed signals; the
   terminal/files/git hooks project Channel-A data; stream.url.rotated folds in.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { OpenGeniApiError, type SessionEvent } from "@opengeni/sdk";
import { registerDom, renderHook, flush } from "./render-hook";
import { fakeClient, SESSION_ID, WORKSPACE_ID } from "./fake-client";
import {
  fakeAttachResponse,
  fakeCapabilities,
  fakeColdCapabilities,
  fakeEvent,
  fakeHeadlessCapabilities,
} from "./sandbox-fixtures";
import { useSandboxFiles } from "../src/hooks/use-sandbox-files";
import { useSandboxGit } from "../src/hooks/use-sandbox-git";
import { useSandboxTerminal } from "../src/hooks/use-sandbox-terminal";
import { useSessionCapabilities } from "../src/hooks/use-session-capabilities";

registerDom();

const ctx = { workspaceId: WORKSPACE_ID };

describe("useSessionCapabilities", () => {
  test("a warm session negotiates to ready and exposes the doc as UI truth", async () => {
    const client = fakeClient({ getStreamCapabilities: async () => fakeCapabilities() });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client }),
      undefined,
    );
    await flush();
    expect(hook.result.current.state).toBe("ready");
    expect(hook.result.current.capabilities?.DesktopStream.transport).toBe("vnc-ws");
    expect(hook.result.current.capabilities?.FileSystem.available).toBe(true);
    await hook.unmount();
  });

  test("a headless backend negotiates ready with desktop transport null (gated off)", async () => {
    const client = fakeClient({ getStreamCapabilities: async () => fakeHeadlessCapabilities() });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client }),
      undefined,
    );
    await flush();
    expect(hook.result.current.state).toBe("ready");
    // The desktop surface is present-but-unavailable (a value, never a crash).
    expect(hook.result.current.capabilities?.DesktopStream.transport).toBeNull();
    expect(hook.result.current.capabilities?.DesktopStream.reason).toBe("backend_unsupported");
    await hook.unmount();
  });

  test("a cold lease degrades gracefully: state cold, then polls toward warm", async () => {
    let calls = 0;
    const client = fakeClient({
      getStreamCapabilities: async () => {
        calls += 1;
        // First read cold; subsequent polls return warm.
        return calls >= 2 ? fakeCapabilities({ liveness: "warm" }) : fakeColdCapabilities();
      },
    });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client, warmingPollMs: 5 }),
      undefined,
    );
    await flush();
    expect(hook.result.current.state).toBe("cold");
    // Let the poll fire and observe warm.
    await flush(20);
    expect(hook.result.current.state).toBe("ready");
    await hook.unmount();
  });

  test("desktop attach 409 surfaces an acknowledgment requirement (consent prompt)", async () => {
    const client = fakeClient({
      getStreamCapabilities: async () => fakeCapabilities(),
      attachViewer: async () => {
        throw new OpenGeniApiError(409, "stream_acknowledgment_required");
      },
    });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client, attachDesktop: true }),
      undefined,
    );
    await flush();
    expect(hook.result.current.acknowledgmentRequired).toBe("unredacted");
    // Structured surfaces still negotiated; the session is still usable.
    expect(hook.result.current.capabilities?.FileSystem.available).toBe(true);
    await hook.unmount();
  });

  test("desktop attach 409 shared_acknowledgment maps to the shared consent", async () => {
    const client = fakeClient({
      getStreamCapabilities: async () => fakeCapabilities({ DesktopStream: { ...fakeCapabilities().DesktopStream, shared: true } }),
      attachViewer: async () => {
        throw new OpenGeniApiError(409, "shared_acknowledgment_required");
      },
    });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client, attachDesktop: true }),
      undefined,
    );
    await flush();
    expect(hook.result.current.acknowledgmentRequired).toBe("shared");
    await hook.unmount();
  });

  test("desktop attach 429 surfaces the viewer cap (friendly message path)", async () => {
    const client = fakeClient({
      getStreamCapabilities: async () => fakeCapabilities(),
      attachViewer: async () => {
        throw new OpenGeniApiError(429, "viewer cap reached");
      },
    });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client, attachDesktop: true }),
      undefined,
    );
    await flush();
    expect(hook.result.current.viewerCapReached).toBe(true);
    await hook.unmount();
  });

  test("a successful desktop attach folds the minted live address into the doc", async () => {
    const client = fakeClient({
      getStreamCapabilities: async () => fakeCapabilities({ DesktopStream: { ...fakeCapabilities().DesktopStream, url: null, token: null } }),
      attachViewer: async () => fakeAttachResponse(),
      heartbeatViewer: async () => ({ alive: true }),
      detachViewer: async () => {},
    });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client, attachDesktop: true }),
      undefined,
    );
    await flush();
    expect(hook.result.current.viewerId).toBe("44444444-4444-4444-8444-444444444444");
    expect(hook.result.current.capabilities?.DesktopStream.url).toContain("box.modal.example");
    await hook.unmount();
  });

  test("a 403 on negotiate is a hard error (forbidden viewer)", async () => {
    const client = fakeClient({
      getStreamCapabilities: async () => {
        throw new OpenGeniApiError(403, "forbidden");
      },
    });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client }),
      undefined,
    );
    await flush();
    expect(hook.result.current.state).toBe("error");
    await hook.unmount();
  });

  test("a later stream.url.rotated folds a fresh url in, fencing stale epochs", async () => {
    const client = fakeClient({ getStreamCapabilities: async () => fakeCapabilities({ leaseEpoch: 2 }) });
    const events: SessionEvent[] = [];
    const hook = await renderHook(
      (props: { events: SessionEvent[] }) => useSessionCapabilities(SESSION_ID, { ...ctx, client, events: props.events }),
      { events },
    );
    await flush();
    const before = hook.result.current.capabilities?.DesktopStream.url;
    // A stale rotation (epoch 1 < known 2) is dropped; a fresh one (epoch 3) wins.
    const rotated = [
      fakeEvent(10, "stream.url.rotated", {
        url: "https://stale.example/vnc.html", token: "t", expiresAt: null, leaseEpoch: 1, transport: "vnc-ws", viewerId: null,
      }),
      fakeEvent(11, "stream.url.rotated", {
        url: "https://fresh.example/vnc.html", token: "t2", expiresAt: null, leaseEpoch: 3, transport: "vnc-ws", viewerId: null,
      }),
    ];
    await hook.rerender({ events: rotated });
    await flush();
    expect(hook.result.current.capabilities?.DesktopStream.url).not.toBe(before);
    expect(hook.result.current.capabilities?.DesktopStream.url).toContain("fresh.example");
    await hook.unmount();
  });

  test("attachDesktop on a headless backend never calls attachViewer (graceful)", async () => {
    let attachCalls = 0;
    const client = fakeClient({
      getStreamCapabilities: async () => fakeHeadlessCapabilities(),
      attachViewer: async () => {
        attachCalls += 1;
        throw new Error("should not be called");
      },
    });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client, attachDesktop: true }),
      undefined,
    );
    await flush();
    expect(attachCalls).toBe(0);
    expect(hook.result.current.state).toBe("ready");
    expect(hook.result.current.capabilities?.DesktopStream.transport).toBeNull();
    await hook.unmount();
  });

  test("disabled hook stays idle (panel collapsed)", async () => {
    const client = fakeClient({ getStreamCapabilities: async () => fakeCapabilities() });
    const hook = await renderHook(
      () => useSessionCapabilities(SESSION_ID, { ...ctx, client, enabled: false }),
      undefined,
    );
    await flush();
    expect(hook.result.current.state).toBe("idle");
    expect(hook.result.current.capabilities).toBeNull();
    await hook.unmount();
  });
});

describe("useSandboxTerminal", () => {
  test("projects the agent firehose + pty output into ordered chunks", async () => {
    const events: SessionEvent[] = [
      fakeEvent(1, "sandbox.command.output.delta", { stream: "stdout", chunk: "hello\n" }),
      fakeEvent(2, "terminal.pty.started", { ptyId: "p1", cols: 80, rows: 24, shell: "/bin/bash", cwd: "" }),
      fakeEvent(3, "terminal.pty.output.delta", { ptyId: "p1", stream: "stdout", chunk: "$ ls\n", seq: 0 }),
      fakeEvent(4, "terminal.pty.output.delta", { ptyId: "p1", stream: "stderr", chunk: "oops\n", seq: 1 }),
    ];
    const client = fakeClient({});
    const hook = await renderHook(
      () => useSandboxTerminal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events }),
      undefined,
    );
    await flush();
    const result = hook.result.current;
    expect(result.chunks.map((c) => c.text)).toEqual(["hello\n", "$ ls\n", "oops\n"]);
    expect(result.running).toBe(true);
    // The default pty (supportsInput true on started) yields a write fn.
    expect(typeof result.write).toBe("function");
    await hook.unmount();
  });

  test("interactive mode OPENS a pty and exposes write before the started event arrives", async () => {
    // The read-only bug: nothing ever opened a PTY, so write stayed null and the
    // terminal could only watch. interactive:true must call terminalPtyOpen and
    // surface `write` immediately (bound to the returned ptyId), then close on
    // unmount.
    const opens: unknown[] = [];
    const writes: { ptyId: string; data: string }[] = [];
    const closes: string[] = [];
    const client = fakeClient({
      terminalPtyOpen: async () => { opens.push(true); return { ptyId: "opened-1", streamVia: "sse-events" as const, supportsInput: true }; },
      terminalPtyWrite: async (_ws, _s, req) => { writes.push(req); },
      terminalPtyClose: async (_ws, _s, req) => { closes.push(req.ptyId); },
    });
    const hook = await renderHook(
      // No started event yet — write must still be live off the open's response.
      () => useSandboxTerminal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [], interactive: true }),
      undefined,
    );
    await flush();
    expect(opens.length).toBe(1);
    expect(hook.result.current.activePtyId).toBe("opened-1");
    expect(typeof hook.result.current.write).toBe("function");
    hook.result.current.write?.("ls\n");
    await flush();
    expect(writes).toEqual([{ ptyId: "opened-1", data: "ls\n" }]);
    await hook.unmount();
    await flush();
    expect(closes).toContain("opened-1");
  });

  test("non-interactive (default) NEVER opens a pty (projection-only)", async () => {
    let opened = false;
    const client = fakeClient({ terminalPtyOpen: async () => { opened = true; return { ptyId: "x", streamVia: "sse-events" as const, supportsInput: true }; } });
    const hook = await renderHook(
      () => useSandboxTerminal(SESSION_ID, { client, workspaceId: WORKSPACE_ID, events: [] }),
      undefined,
    );
    await flush();
    expect(opened).toBe(false);
    expect(hook.result.current.write).toBeNull();
    await hook.unmount();
  });

  test("a closed pty stops running and drops the write fn", async () => {
    const events: SessionEvent[] = [
      fakeEvent(1, "terminal.pty.started", { ptyId: "p1", cols: 80, rows: 24, shell: "/bin/bash", cwd: "" }),
      fakeEvent(2, "terminal.pty.exited", { ptyId: "p1", exitCode: 0, reason: "exit" }),
    ];
    const hook = await renderHook(
      () => useSandboxTerminal(SESSION_ID, { client: fakeClient({}), workspaceId: WORKSPACE_ID, events }),
      undefined,
    );
    await flush();
    expect(hook.result.current.running).toBe(false);
    expect(hook.result.current.write).toBeNull();
    await hook.unmount();
  });
});

describe("useSandboxFiles", () => {
  test("lists the tree (depth 1) and overlays git status, expands lazily", async () => {
    const listCalls: string[] = [];
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true, head: "main", detached: false, upstream: null, ahead: 0, behind: 0,
        files: [{ path: "src/app.ts", oldPath: null, index: null, worktree: "modified", isConflicted: false }],
        revision: 1,
      }),
      fsList: async (_ws, _s, req) => {
        listCalls.push(req?.path ?? "");
        if ((req?.path ?? "") === "src") {
          return {
            root: { name: "src", path: "src", type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false, children: [
              { name: "app.ts", path: "src/app.ts", type: "file", sizeBytes: 100, mtimeMs: null, mode: null, truncated: false },
            ] },
            revision: 1, truncated: false,
          };
        }
        return {
          root: { name: "", path: "", type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false, children: [
            { name: "src", path: "src", type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false },
            { name: "README.md", path: "README.md", type: "file", sizeBytes: 10, mtimeMs: null, mode: null, truncated: false },
          ] },
          revision: 1, truncated: false,
        };
      },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.tree.map((n) => n.name)).toEqual(["src", "README.md"]);
    // Lazy expand "src".
    await hook.result.current.expand("src");
    await flush();
    const src = hook.result.current.tree.find((n) => n.path === "src");
    expect(src?.children?.[0]?.name).toBe("app.ts");
    // The modified file carries the git-status overlay.
    expect(src?.children?.[0]?.status).toBe("modified");
    expect(listCalls).toContain("src");
    await hook.unmount();
  });

  test("a depth-bounded dir (children: []) is treated as unexpanded so lazy expand fires", async () => {
    // The REAL bug: a live depth-1 fsList returns each dir at the boundary with
    // `children: []` (listed, but grandchildren not). If we kept `[]` the
    // FileBrowser's `children === undefined` lazy-expand guard never fires and
    // clicking the folder does nothing. fsNodeToTree must map empty -> undefined.
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false, head: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 0,
      }),
      fsList: async () => ({
        root: { name: "", path: "", type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false, children: [
          // The provider returns an EMPTY children array for the depth-boundary dir.
          { name: ".config", path: ".config", type: "dir", sizeBytes: null, mtimeMs: 1, mode: 493, truncated: false, children: [] },
        ] },
        revision: 0, truncated: false,
      }),
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    const dir = hook.result.current.tree.find((n) => n.path === ".config");
    expect(dir?.kind).toBe("dir");
    // children must be UNDEFINED (the unexpanded marker), NOT [] — else expand
    // is dead and the folder renders as a permanently-empty leaf.
    expect(dir?.children).toBeUndefined();
    await hook.unmount();
  });

  test("readFile proxies fs.read for the viewer pane (no repo required)", async () => {
    const reads: string[] = [];
    const client = fakeClient({
      gitStatus: async () => ({ isRepo: false, head: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 0 }),
      fsList: async () => ({
        root: { name: "", path: "", type: "dir", sizeBytes: null, mtimeMs: null, mode: null, truncated: false, children: [
          { name: "main.ts", path: "main.ts", type: "file", sizeBytes: 12, mtimeMs: null, mode: null, truncated: false },
        ] },
        revision: 0, truncated: false,
      }),
      fsRead: async (_ws, _s, req) => {
        reads.push(req.path);
        return { path: req.path, encoding: "utf8" as const, content: "export {}\n", sizeBytes: 10, truncated: false, isBinary: false, revision: 0 };
      },
    });
    const hook = await renderHook(
      () => useSandboxFiles(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    const res = await hook.result.current.readFile("main.ts");
    expect(res.content).toBe("export {}\n");
    expect(reads).toEqual(["main.ts"]);
    await hook.unmount();
  });
});

describe("useSandboxGit", () => {
  test("projects status + diff into the Pierre hunk contract", async () => {
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: true, head: "feature", detached: false, upstream: "origin/feature", ahead: 1, behind: 0,
        files: [], revision: 1,
      }),
      gitDiff: async () => ({
        files: [{
          path: "a.ts", oldPath: null, status: "modified", isBinary: false, isImage: false,
          additions: 1, deletions: 0, truncated: false,
          hunks: [{ oldStart: 1, oldLines: 0, newStart: 1, newLines: 1, header: "@@", lines: [{ type: "add", oldNo: null, newNo: 1, text: "x" }] }],
        }],
        revision: 1,
      }),
    });
    const hook = await renderHook(
      () => useSandboxGit(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.isRepo).toBe(true);
    expect(hook.result.current.branch).toBe("feature");
    expect(hook.result.current.ahead).toBe(1);
    expect(hook.result.current.diff[0]?.hunks[0]?.lines[0]?.type).toBe("add");
    await hook.unmount();
  });

  test("a non-repo box reports isRepo false with an empty diff (not an error)", async () => {
    const client = fakeClient({
      gitStatus: async () => ({
        isRepo: false, head: null, detached: false, upstream: null, ahead: 0, behind: 0, files: [], revision: 0,
      }),
    });
    const hook = await renderHook(
      () => useSandboxGit(SESSION_ID, { client, workspaceId: WORKSPACE_ID }),
      undefined,
    );
    await flush();
    expect(hook.result.current.isRepo).toBe(false);
    expect(hook.result.current.diff).toEqual([]);
    expect(hook.result.current.error).toBeNull();
    await hook.unmount();
  });
});
