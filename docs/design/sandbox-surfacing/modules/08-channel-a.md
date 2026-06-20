# Module: Channel A — structured services (FileSystem/Terminal/Git)  (channel-a)

## Specification

# MODULE SPEC — Channel A: Structured Services (FileSystem / Terminal / Git)

**The typed services that ride the event-bus / request-response plane — files, git, terminal-as-events + interactive PTY. NOT pixels (that is Channel B).**

This is the implementation-grade master spec for the structured-services module of the OpenGeni sandbox-surfacing vision. Everything below is grounded against HEAD and the `@openai/agents-{core,extensions}@0.11.6` SDK. It builds on the settled lease architecture and the dual-channel data path — it does **not** re-litigate them.

> **SUPERSEDED transport note (API-direct control-plane ruling — see `00-master-spine.md` §B.2/§B.3 and `modules/02-owner.md`).** This module predates **two** rulings and was written against the old in-worker `SandboxOwner` actor + per-session `sandbox-owner::<sessionId>` task-queue model, then briefly re-cast onto a short-lived `sandboxOwnerRpcWorkflow`. **Both transports are gone.** There is **no `SandboxOwner` actor**, **no `Map<sessionId, SandboxOwner>`**, **no per-session/per-group task queue**, and **no `sandboxOwnerRpcWorkflow` / worker-RPC hop for non-turn ops**. The **capability content of this module is unchanged and not weakened** — only the transport/placement is restated to the **AUTHORITATIVE CORRECTED MODEL: the control plane is API-direct.** Every A2 request/response service (FS list/read/write/search, Git status/diff/log/show, PTY open/write/resize/close) is served **client → API → box** by the API process itself: the API imports a thin shared sandbox module (`@opengeni/runtime/sandbox`: `createSandboxClient` + the envelope (de)serializers), `resume()`s the box **by id** from the group lease's stored envelope **in-process**, runs `session.exec`/`readFile`/`createEditor`, returns inline JSON, and drops the handle when the request completes. The cold→warming lease CAS is a **Postgres transaction the API owns**; the API already makes outbound HTTPS (Stripe/OpenAI/GitHub) and owns Postgres, and `ModalSandboxClient.resume()` is per-call with no pool/singleton, so this needs no Temporal and no NATS round-trip. **NATS carries events only** (A1: `fs.changed`/`git.changed`/`terminal.pty.*` fan-out via worker→NATS→API-SSE→client). Read every "route to a Temporal activity on `sandbox-owner::<sessionId>`", "`owners.get(sessionId)`", "in-worker `Map`", "`owner_task_queue`", "`sandboxOwnerRpcWorkflow`", and "owner-RPC" below as **"served API-direct: the API resumes the box by id in-process and operates the live `session` handle"**; they are retained verbatim for provenance only.

---

## 0. The load-bearing architectural decision for Channel A (read first)

Channel A splits into **two transports with two different durability/auth contracts**, and the single most important design decision in this module is which service rides which:

| Transport | Mechanism | Used by | Durability | Auth |
|---|---|---|---|---|
| **A1 — Event broadcast** | `appendAndPublishEvents` → `session_events` (DB-sequenced) → NATS → SSE fan-out (`apps/api/src/http/sse.ts:5`) | Terminal **output** stream (already `sandbox.command.output.delta`); FS/Git **change notifications** (`fs.changed`, `git.changed`) | Durable, sequenced, replayable, gap-filled | Auth-per-read on the SSE route: `requireAccessGrant(c, deps, workspaceId, "sessions:read")` (`apps/api/src/routes/sessions.ts:216`) |
| **A2 — Request/response** | A NEW synchronous HTTP route that serves the call **API-direct**: the API resumes the box **by id** from the group lease envelope in-process and operates the live `session` handle, returning inline JSON. **No Temporal, no worker RPC, no NATS round-trip in this path.** | FS `list/read/write/search`; Git `status/diff/log/show`; Terminal `pty.open/write/resize/close` control | Ephemeral (one round-trip; the **result** is durable only if the caller also emits a change event) | Auth-per-call on the route: `"files:read"` / `"files:upload"` / `"sessions:read"` / `"sessions:control"` |

**Why two transports.** The event bus is a broadcast log — perfect for "the terminal printed bytes" or "a file changed" (every viewer must see it, in order, replayable). It is **wrong** for "read me file X right now and give me its 4 MB of bytes": that is a point query with a large, caller-specific, non-broadcast result that must not be appended to every viewer's event log. So FileSystem reads, Git diffs, and PTY control are **A2 request/response**, while their *side-effect notifications* and the terminal *output firehose* are **A1 events**.

**The critical routing fact (CORRECTED MODEL — API-direct):** today the API process holds **no sandbox client** — `dependencies.ts` is `{db, bus, workflowClient, objectStorage}`. The corrected ruling is that Channel A's A2 services **give the API a sandbox client of its own** rather than routing through Temporal. The API imports a thin shared module (`@opengeni/runtime/sandbox`) exposing `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState` — extracted so `apps/api` pulls it **without** the `@openai/agents` agent-loop import graph (verified: the sandbox-client functions have zero coupling to the agent-loop/Temporal/model-provider code; `packages/runtime` has no `@temporalio` dep). With the Modal token plumbed into the API's Modal-client construction (already parsed by the shared `getSettings`, `packages/config`) and egress to `api.modal.com` confirmed, the A2 route handler **resumes the box by id** from the group lease's stored envelope **in-process** (`ModalSandboxClient.resume()` is per-call, no pool/singleton), operates the live `SandboxSessionLike` handle directly (`session.exec`/`readFile`/`createEditor`), runs the **cold→warming lease CAS as a Postgres transaction it owns**, acquires/releases a **viewer-kind lease holder** for the duration of the call, and drops the handle on return. There is **no Temporal activity, no per-session task queue, no in-worker `Map<sessionId, SandboxOwner>`, and no NATS request/reply** in this synchronous path — it is the same shape as the API's existing outbound HTTPS calls (Stripe/OpenAI/GitHub) plus its existing Postgres ownership. The note below about `dependencies.ts` adds **one** field: a Modal/sandbox client constructed from settings.

---

## 1. The SDK primitives Channel A rides (grounded inventory)

Every method below is on `SandboxSession<TState>` (`@openai/agents-core@0.11.6/dist/sandbox/session.d.ts:101-127`), all OPTIONAL — Channel A must capability-probe each before use and degrade to an `exec`-shell fallback or report `available:false`.

```ts
// session.d.ts:101 — what Channel A consumes off the owner's live handle
interface SandboxSession<TState> {
  exec?(args: ExecCommandArgs): Promise<SandboxExecResult>;          // :112  PRIMARY — git/search/stat via shell
  execCommand?(args: ExecCommandArgs): Promise<string>;             // :113  fallback (string-only)
  writeStdin?(args: WriteStdinArgs): Promise<string>;              // :114  PTY stdin (sessionId-keyed)
  readFile?(args: ReadFileArgs): Promise<string | Uint8Array>;     // :116  FS.read (text|binary, maxBytes)
  listDir?(args: ListDirectoryArgs): Promise<SandboxDirectoryEntry[]>; // :117  FS.list (one level)
  pathExists?(path, runAs?): Promise<boolean>;                     // :118  FS.exists
  createEditor?(runAs?): Editor;                                   // :111  FS.write/delete (apply-patch)
  resolveExposedPort?(port): Promise<ExposedPortEndpoint>;          // :124  Channel B only — NOT used here
  supportsPty?(): boolean;                                         // :125  PTY capability gate
}
```

Grounded shapes (verbatim from `session.d.ts`):

```ts
type ExecCommandArgs = {                  // :39
  cmd: string; workdir?: string; shell?: string; login?: boolean;
  tty?: boolean; yieldTimeMs?: number; maxOutputTokens?: number; runAs?: string;
};
type SandboxExecResult = {                // :49
  output: string; stdout: string; stderr: string; wallTimeSeconds: number;
  exitCode?: number | null; sessionId?: number; originalTokenCount?: number;
};
type WriteStdinArgs = {                    // :58
  sessionId: number; chars?: string; yieldTimeMs?: number; maxOutputTokens?: number;
};
type ReadFileArgs = { path: string; runAs?: string; maxBytes?: number };   // :68
type ListDirectoryArgs = { path: string; runAs?: string };                 // :73
type SandboxDirectoryEntry = { name: string; path: string; type: 'file' | 'dir' | 'other' };  // :77
```

The **file write/delete** path is `createEditor(runAs?) → Editor` (`RemoteSandboxEditor`, `extensions/dist/sandbox/shared/editor.d.ts:3`) which exposes `createFile/updateFile/deleteFile(op)` over a `RemoteEditorIo` (`shared/types.d.ts:5`: `readText/writeText/deletePath/mkdir?/pathExists?`). The op shapes are the SDK `ApplyPatchOperation` discriminated union (`@openai/agents-core`).

**The terminal-output firehose already exists.** `sandbox.command.output.delta` is a live event type (`packages/contracts/src/index.ts:1295`), classified **structural** in the batcher (`apps/worker/src/activities/streaming.ts:11`), and folded by the React timeline (`packages/react/src/timeline.ts:331`). Channel A's Terminal *read* path is therefore **already built** — it is the agent's command output, broadcast on A1. What is NEW is (a) a richer payload contract for it, (b) an interactive **PTY** channel (stdin/resize) layered on `writeStdin` + a new pty session lifecycle.

**Per-provider capability matrix for Channel A** (from the SDK-clients survey — this is what each service's capability probe must encode):

| Service primitive | modal | e2b | daytona | runloop | blaxel | vercel | cloudflare |
|---|---|---|---|---|---|---|---|
| `exec` (git/search/stat) | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `readFile`/`listDir`/`createEditor` | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| `writeStdin` + `supportsPty()` | ✅ `true` | ⚠️ conditional | ⚠️ conditional | ❌ `false` | ⚠️ conditional | ❌ `false` | ✅ `true` |
| `runAs` (multi-user) | ✅ | ❌ throws | ✅ | ❌ throws | ❌ throws | ❌ throws | ✅ |

So **Terminal interactive PTY** is desktop-tier-correlated but not identical: runloop/vercel hardcode `supportsPty()=false` → those tiers get **buffered-exec terminal only** (no interactive stdin), and the capability handshake must say so. FS/Git ride `exec`+`readFile`+`createEditor`, available on **all 7**.

---

## 2. New Zod contracts (`packages/contracts/src/index.ts`)

These are the source of truth. Per the settled propagation chain, each must be mirrored in `packages/sdk/src/types.ts` (parity test `packages/sdk/test/contract-parity.test.ts` fails on drift) and folded in `packages/react/src/timeline.ts` where it is an *event*.

### 2.1 New permissions (append to `Permission`, `:57`)

```ts
// packages/contracts/src/index.ts — Permission enum, after "files:read" (:69)
  "files:write",          // FS.write/delete (separate from upload-to-blob "files:upload")
  "terminal:attach",      // open/drive an interactive PTY
// (git status/diff/log/show ride "files:read"; no new git permission — read-only inspection)
```

`files:read` already exists (`:69`) and covers FS.list/read/search + Git read. `files:upload` (`:69`) stays the blob-upload permission. `hasPermission` super-permission `workspace:admin` (`apps/api/src/access/index.ts:55`) covers all.

### 2.2 New event types (append to `SessionEventType`, `:1270`)

```ts
// after "sandbox.command.output.delta" (:1295)
  "fs.changed",                  // A1 notification: a path was created/modified/deleted (write or watch)
  "git.changed",                 // A1 notification: working-tree/index/HEAD changed (debounced)
  "terminal.pty.started",        // A1: an interactive PTY session opened (carries ptyId)
  "terminal.pty.output.delta",   // A1: PTY stdout/stderr bytes (separate stream from command.output)
  "terminal.pty.exited",         // A1: PTY session ended (exitCode)
```

Mirror in `packages/sdk/src/types.ts` `SESSION_EVENT_TYPES` (`:100`) in the same order. Because `SessionEventType = KnownSessionEventType | (string & {})` (`sdk/types.ts:141`), older SDKs tolerate these — non-breaking.

### 2.3 Event payload schemas (new, in contracts; export + mirror types in sdk)

```ts
// --- A1 event payloads ---------------------------------------------------

// Reuse/extend the existing terminal firehose payload (sandbox.command.output.delta)
export const SandboxCommandOutputDeltaPayload = z.object({
  stream: z.enum(["stdout", "stderr"]).default("stdout"),
  chunk: z.string(),                       // raw bytes, utf-8 (lossy) — terminal is opaque-ish
  commandId: z.string().optional(),        // groups deltas to one agent command
  seq: z.number().int().nonnegative().optional(), // intra-command ordering hint
});
export type SandboxCommandOutputDeltaPayload = z.infer<typeof SandboxCommandOutputDeltaPayload>;

export const FsChangeKind = z.enum(["created", "modified", "deleted", "renamed"]);
export const FsChangedPayload = z.object({
  changes: z.array(z.object({
    path: z.string(),                      // workspace-relative POSIX path
    kind: FsChangeKind,
    isDir: z.boolean().default(false),
    sizeBytes: z.number().int().nonnegative().nullable().default(null),
    oldPath: z.string().optional(),        // for "renamed"
  })).min(1),
  source: z.enum(["write", "watch", "agent"]).default("write"), // who caused it
  revision: z.number().int().nonnegative(), // monotonic FS revision (see §4.4)
});
export type FsChangedPayload = z.infer<typeof FsChangedPayload>;

export const GitChangedPayload = z.object({
  head: z.string().nullable(),             // current branch or detached SHA
  dirty: z.boolean(),                      // working tree has uncommitted changes
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  changedFileCount: z.number().int().nonnegative(),
  reason: z.enum(["commit", "checkout", "stage", "worktree", "fetch", "unknown"]).default("unknown"),
});
export type GitChangedPayload = z.infer<typeof GitChangedPayload>;

export const TerminalPtyStartedPayload = z.object({
  ptyId: z.string().uuid(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive(),
  shell: z.string(),                       // resolved shell, e.g. "/bin/bash"
  cwd: z.string(),
});
export type TerminalPtyStartedPayload = z.infer<typeof TerminalPtyStartedPayload>;

export const TerminalPtyOutputDeltaPayload = z.object({
  ptyId: z.string().uuid(),
  chunk: z.string(),                       // raw terminal bytes (incl. ANSI), utf-8 lossy
  seq: z.number().int().nonnegative(),     // strict per-pty ordering (the box assigns)
});
export type TerminalPtyOutputDeltaPayload = z.infer<typeof TerminalPtyOutputDeltaPayload>;

export const TerminalPtyExitedPayload = z.object({
  ptyId: z.string().uuid(),
  exitCode: z.number().int().nullable(),
  reason: z.enum(["exit", "killed", "owner_gone", "timeout"]),
});
export type TerminalPtyExitedPayload = z.infer<typeof TerminalPtyExitedPayload>;
```

### 2.4 A2 request/response contracts (NEW Zod objects — request bodies + response shapes)

These are NOT events. They are parsed on new HTTP routes (§5) and returned inline.

```ts
// ===== FileSystem =====
export const FsNodeType = z.enum(["file", "dir", "symlink", "other"]);
export const FsTreeNode = z.object({
  name: z.string(),
  path: z.string(),                         // workspace-relative POSIX, no leading slash
  type: FsNodeType,
  sizeBytes: z.number().int().nonnegative().nullable(),  // null for dirs
  mtimeMs: z.number().int().nonnegative().nullable(),
  mode: z.number().int().nullable(),        // unix mode bits, for Pierre tree icons/perms
  // children present ONLY when the list was requested with depth>0 for this node
  children: z.lazy((): z.ZodTypeAny => z.array(FsTreeNode)).optional(),
  truncated: z.boolean().default(false),    // dir had more entries than the cap
});
export type FsTreeNode = z.infer<typeof FsTreeNode>;

export const FsListRequest = z.object({
  path: z.string().default(""),             // "" = workspace root
  depth: z.number().int().min(0).max(8).default(1),
  // hard cap: total nodes returned (protects the event loop + payload size)
  maxEntries: z.number().int().positive().max(20_000).default(2_000),
  includeHidden: z.boolean().default(true),
  // gitignore-aware listing (runs `git check-ignore` batch when in a repo)
  respectGitignore: z.boolean().default(false),
});
export const FsListResponse = z.object({
  root: FsTreeNode,
  revision: z.number().int().nonnegative(), // FS revision the snapshot was taken at
  truncated: z.boolean(),                   // global cap hit
});

export const FsReadRequest = z.object({
  path: z.string(),
  // encoding contract: "utf8" => returns text; "base64" => binary as base64
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  maxBytes: z.number().int().positive().max(25 * 1024 * 1024).default(5 * 1024 * 1024),
});
export const FsReadResponse = z.object({
  path: z.string(),
  encoding: z.enum(["utf8", "base64"]),
  content: z.string(),                      // text or base64 per encoding
  sizeBytes: z.number().int().nonnegative(),
  truncated: z.boolean(),                   // sizeBytes > maxBytes; content is the prefix
  isBinary: z.boolean(),                    // sniffed NUL byte in first 8KB
  mode: z.number().int().nullable(),
  revision: z.number().int().nonnegative(),
});

export const FsWriteRequest = z.object({
  path: z.string(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  content: z.string(),
  // create-or-overwrite semantics; if false and path exists => 409
  overwrite: z.boolean().default(true),
  createParents: z.boolean().default(true),
});
export const FsWriteResponse = z.object({
  path: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  revision: z.number().int().nonnegative(), // post-write revision (== the fs.changed revision)
});

export const FsDeleteRequest = z.object({
  path: z.string(),
  recursive: z.boolean().default(false),    // required true to delete a non-empty dir
});

export const FsSearchRequest = z.object({
  // ripgrep-backed; falls back to grep -rn if rg absent
  query: z.string().min(1),
  isRegex: z.boolean().default(false),
  caseSensitive: z.boolean().default(false),
  path: z.string().default(""),             // search root
  globs: z.array(z.string()).default([]),   // rg --glob filters
  maxResults: z.number().int().positive().max(5_000).default(500),
  maxResultsPerFile: z.number().int().positive().max(500).default(50),
  contextLines: z.number().int().min(0).max(10).default(0),
});
export const FsSearchMatch = z.object({
  path: z.string(),
  line: z.number().int().positive(),
  column: z.number().int().positive(),
  preview: z.string(),                      // the matching line (truncated to 500 chars)
  before: z.array(z.string()).default([]),  // context
  after: z.array(z.string()).default([]),
});
export const FsSearchResponse = z.object({
  matches: z.array(FsSearchMatch),
  truncated: z.boolean(),
  filesSearched: z.number().int().nonnegative(),
});

// ===== Git =====  (all read-only; feeds Pierre diff/tree)
export const GitFileStatusCode = z.enum([
  "added", "modified", "deleted", "renamed", "copied", "untracked", "ignored", "conflicted", "typechange",
]);
export const GitFileStatus = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),           // for renamed/copied
  index: GitFileStatusCode.nullable(),      // staged change (X in porcelain XY)
  worktree: GitFileStatusCode.nullable(),   // unstaged change (Y in porcelain XY)
  isConflicted: z.boolean().default(false),
});
export const GitStatusRequest = z.object({
  path: z.string().default(""),             // repo root within workspace (multi-repo support)
});
export const GitStatusResponse = z.object({
  isRepo: z.boolean(),
  head: z.string().nullable(),              // branch name
  detached: z.boolean().default(false),
  upstream: z.string().nullable(),
  ahead: z.number().int().nonnegative().default(0),
  behind: z.number().int().nonnegative().default(0),
  files: z.array(GitFileStatus),
  revision: z.number().int().nonnegative(), // git revision (see §4.4)
});

// The structured hunk shape that feeds Pierre diff (the whole point of Git service)
export const GitDiffLineType = z.enum(["context", "add", "del", "meta"]);
export const GitDiffLine = z.object({
  type: GitDiffLineType,
  // null on the side that doesn't have the line (add => oldNo null; del => newNo null)
  oldNo: z.number().int().positive().nullable(),
  newNo: z.number().int().positive().nullable(),
  text: z.string(),                         // line WITHOUT leading +/-/space marker
});
export const GitDiffHunk = z.object({
  oldStart: z.number().int().nonnegative(),
  oldLines: z.number().int().nonnegative(),
  newStart: z.number().int().nonnegative(),
  newLines: z.number().int().nonnegative(),
  header: z.string(),                       // the @@ ... @@ section heading
  lines: z.array(GitDiffLine),
});
export const GitFileDiff = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: GitFileStatusCode,
  isBinary: z.boolean().default(false),
  isImage: z.boolean().default(false),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
  hunks: z.array(GitDiffHunk),              // empty if binary or truncated
  truncated: z.boolean().default(false),    // diff exceeded maxBytes; hunks omitted
});
export const GitDiffRequest = z.object({
  path: z.string().default(""),             // repo root
  // diff selectors, mutually exclusive precedence: refs > staged > worktree
  staged: z.boolean().default(false),       // --cached (index vs HEAD)
  fromRef: z.string().optional(),           // e.g. HEAD~1
  toRef: z.string().optional(),             // e.g. HEAD
  pathspec: z.array(z.string()).default([]),// limit to paths
  contextLines: z.number().int().min(0).max(10).default(3),
  maxBytesPerFile: z.number().int().positive().max(2 * 1024 * 1024).default(512 * 1024),
});
export const GitDiffResponse = z.object({
  files: z.array(GitFileDiff),
  revision: z.number().int().nonnegative(),
});

export const GitLogRequest = z.object({
  path: z.string().default(""),
  ref: z.string().default("HEAD"),
  maxCount: z.number().int().positive().max(1_000).default(100),
  skip: z.number().int().nonnegative().default(0),
  pathspec: z.array(z.string()).default([]),
});
export const GitCommit = z.object({
  sha: z.string(),
  shortSha: z.string(),
  parents: z.array(z.string()),
  author: z.object({ name: z.string(), email: z.string(), timestamp: z.number().int() }),
  committer: z.object({ name: z.string(), email: z.string(), timestamp: z.number().int() }),
  subject: z.string(),
  body: z.string(),
  refs: z.array(z.string()).default([]),    // decorations: branch/tag pointers
});
export const GitLogResponse = z.object({ commits: z.array(GitCommit), hasMore: z.boolean() });

export const GitShowRequest = z.object({
  path: z.string().default(""),
  ref: z.string(),                          // a commit/tag/tree-ish
  // optional single-file blob fetch: ref + filePath => raw blob (for "open file at commit")
  filePath: z.string().optional(),
  encoding: z.enum(["utf8", "base64"]).default("utf8"),
  maxBytesPerFile: z.number().int().positive().max(2 * 1024 * 1024).default(512 * 1024),
});
export const GitShowResponse = z.object({
  commit: GitCommit.nullable(),             // null when fetching a raw blob
  files: z.array(GitFileDiff),              // commit diff vs first parent
  blob: z.object({ content: z.string(), encoding: z.enum(["utf8", "base64"]), sizeBytes: z.number().int(), truncated: z.boolean() }).nullable(),
  revision: z.number().int().nonnegative(),
});

// ===== Terminal PTY control (A2 request/response; output rides A1) =====
export const PtyOpenRequest = z.object({
  cols: z.number().int().positive().max(500).default(80),
  rows: z.number().int().positive().max(300).default(24),
  cwd: z.string().default(""),              // workspace-relative
  shell: z.string().optional(),             // default: resolved login shell
  env: z.record(z.string(), z.string()).default({}),
});
export const PtyOpenResponse = z.object({
  ptyId: z.string().uuid(),
  // output streams as terminal.pty.output.delta on the SSE channel the client already holds
  streamVia: z.literal("sse-events"),
  supportsInput: z.boolean(),              // false on runloop/vercel (supportsPty()=false)
});
export const PtyWriteRequest = z.object({ ptyId: z.string().uuid(), data: z.string() }); // utf-8 stdin
export const PtyResizeRequest = z.object({ ptyId: z.string().uuid(), cols: z.number().int().positive(), rows: z.number().int().positive() });
export const PtyCloseRequest = z.object({ ptyId: z.string().uuid() });
```

### 2.5 Capability advertisement (extend `ClientConfig` AND add a per-session capabilities object)

`ClientConfig` (`:1425`) advertises **server-wide** capability. But Channel A availability is **per-session** (depends on the session's pinned backend). So:

```ts
// Server-wide hint on ClientConfig (does the deployment support structured services at all)
// extend ClientConfig (:1425) with:
  structuredServices: z.object({
    fileSystem: z.boolean(),
    git: z.boolean(),
    terminalEvents: z.boolean(),   // the command-output firehose
  }).default({ fileSystem: false, git: false, terminalEvents: false }),

// Per-session capabilities (NEW object), returned by GET /stream-capabilities (the Channel-B
// handshake route the lease design already adds). Channel A fields live alongside DesktopStream.
export const SessionStructuredCapabilities = z.object({
  FileSystem: z.object({ available: z.boolean(), readOnly: z.boolean(), root: z.string() }),
  Terminal: z.object({
    events: z.boolean(),                                  // command.output firehose (always on if box exists)
    pty: z.object({ available: z.boolean() }),            // interactive stdin (supportsPty())
  }),
  Git: z.object({ available: z.boolean(), repos: z.array(z.string()) }), // detected repo roots
});
export type SessionStructuredCapabilities = z.infer<typeof SessionStructuredCapabilities>;
```

This is the `SessionCapabilities.FileSystem/Terminal/Git` block from the settled capability interface (Ground:capability-pattern §H), now fully typed. Degradation is **always a handshake value, never silent**: `none` backend → all `available:false`; runloop/vercel → `Terminal.pty.available:false`.

---

## 3. SQL DDL (`packages/db/src/schema.ts` + a migration)

Channel A needs **almost no new persistent state** — its output rides the existing `session_events` table (no schema change; `sandbox_backend` is free-text, no enum migration). Two small additions:

### 3.1 `sandbox_pty_sessions` — track open interactive PTYs (for reattach + reap)

An interactive PTY is a live in-box process keyed by the SDK's `WriteStdinArgs.sessionId` (a numeric exec-session id, `session.d.ts:59`). We map our UUID `ptyId` ↔ that numeric id, the owning workspace/session, and a heartbeat so the reaper can kill orphaned PTYs.

```sql
-- migration: NNNN_sandbox_pty_sessions.sql
CREATE TABLE sandbox_pty_sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),     -- == ptyId on the wire
  account_id       uuid NOT NULL REFERENCES managed_accounts(id) ON DELETE CASCADE,
  workspace_id     uuid NOT NULL REFERENCES workspaces(id)        ON DELETE CASCADE,
  session_id       uuid NOT NULL REFERENCES sessions(id)          ON DELETE CASCADE,
  -- the SDK numeric exec-session id used by writeStdin({ sessionId })
  exec_session_id  integer,
  lease_epoch      integer NOT NULL,                               -- fenced to the owner that opened it
  cols             integer NOT NULL,
  rows             integer NOT NULL,
  shell            text NOT NULL,
  cwd              text NOT NULL,
  status           text NOT NULL DEFAULT 'open',                  -- 'open' | 'closed'
  opened_by        uuid NOT NULL,                                 -- viewer grant/subject that opened it
  last_input_at    timestamptz NOT NULL DEFAULT now(),            -- input-activity TTL (reap idle PTYs)
  created_at       timestamptz NOT NULL DEFAULT now(),
  closed_at        timestamptz
);
CREATE INDEX sandbox_pty_sessions_session_idx ON sandbox_pty_sessions (workspace_id, session_id) WHERE status = 'open';
```

Mirrors the FK chain of `sandbox_session_envelopes` (`schema.ts:360`: `accountId→managedAccounts`, `workspaceId→workspaces`, `sessionId→sessions`, all `onDelete:"cascade"`). `lease_epoch` fences a PTY to the owner that created it (Ground §J-c): on owner re-election the new owner cannot drive a PTY opened under a stale epoch — it emits `terminal.pty.exited{reason:"owner_gone"}` and the client must re-open.

Drizzle declaration to add beside `sandboxSessionEnvelopes`:

```ts
export const sandboxPtySessions = pgTable("sandbox_pty_sessions", {
  id: uuid("id").primaryKey().defaultRandom(),
  accountId: uuid("account_id").notNull().references(() => managedAccounts.id, { onDelete: "cascade" }),
  workspaceId: uuid("workspace_id").notNull().references(() => workspaces.id, { onDelete: "cascade" }),
  sessionId: uuid("session_id").notNull().references(() => sessions.id, { onDelete: "cascade" }),
  execSessionId: integer("exec_session_id"),
  leaseEpoch: integer("lease_epoch").notNull(),
  cols: integer("cols").notNull(),
  rows: integer("rows").notNull(),
  shell: text("shell").notNull(),
  cwd: text("cwd").notNull(),
  status: text("status").notNull().default("open"),
  openedBy: uuid("opened_by").notNull(),
  lastInputAt: timestamp("last_input_at", { withTimezone: true }).notNull().defaultNow(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (t) => ({
  openIdx: index("sandbox_pty_sessions_session_idx").on(t.workspaceId, t.sessionId).where(sql`status = 'open'`),
}));
```

### 3.2 No table for FS/Git reads

FS list/read/search and Git status/diff/log/show are **stateless point queries** against the live box. They persist nothing. Their *notifications* (`fs.changed`/`git.changed`) append to `session_events` like every other event — no new table.

**The monotonic `revision` fields** in the response/event payloads are **per-session in-memory counters held on the `SandboxOwner`** (incremented on every FS write the owner performs + on every `fs.changed`/`git.changed` it emits), NOT a DB column. They let a client detect "my cached tree is stale, re-list." They reset to 0 on owner re-election (acceptable: a client seeing `revision` go backwards/jump re-fetches). This is the standard ETag-ish cheap-staleness signal; making it durable is over-engineering for v1.

---

## 4. The service implementations (`@opengeni/runtime/sandbox` service module, called API-direct)

The A2 services live in a **provider-agnostic service module** (`packages/runtime/src/sandbox/channel-a.ts`, re-exported under `@opengeni/runtime/sandbox`) that operates on a live `{client, session, sessionState}` triple. Per the CORRECTED MODEL these methods run **in the API process**: the A2 route handler resumes the box by id in-process and calls the method directly, with no Temporal hop. The same module is also importable by the worker's agent-turn activity for the A1 notification side-effects it already produces in-process (`fs.changed` after an agent file write). There is **no `SandboxOwner` actor and no `Map<sessionId, SandboxOwner>`** — the live handle is whatever the current caller (API request, or agent turn) resumed; it is non-owned and dropped when the call returns.

### 4.1 Service surface (TypeScript)

The surface below is shown as a class for readability (a `SandboxChannelAService` bound to one resumed `{session, db, bus, workspaceId, sessionId}`), but it carries **no singleton/ownership semantics** — the API constructs one per request around the box it just resumed by id, and the agent-turn activity reuses the same methods around its own live handle.

```ts
// packages/runtime/src/sandbox/channel-a.ts — provider-agnostic, called API-direct
export class SandboxChannelAService {
  private revision = 0;
  private readonly ptys = new Map<string /*ptyId*/, { execSessionId: number; cols: number; rows: number }>();
  // bound to one resumed-by-id live { session, db, bus, workspaceId, sessionId } for the call's lifetime

  /** Capability probe — drives SessionStructuredCapabilities. */
  capabilities(): SessionStructuredCapabilities {
    const s = this.session;
    const hasFs = Boolean(s.readFile && s.listDir && s.createEditor);
    return {
      FileSystem: { available: hasFs, readOnly: false, root: this.workspaceRoot },
      Terminal: { events: Boolean(s.exec || s.execCommand), pty: { available: Boolean(s.supportsPty?.() && s.writeStdin) } },
      Git: { available: Boolean(s.exec), repos: [] /* filled by a cheap `git rev-parse` probe, cached */ },
    };
  }

  // ---- FileSystem (A2) ----
  fsList(req: FsListRequest): Promise<FsListResponse>;     // §4.2
  fsRead(req: FsReadRequest): Promise<FsReadResponse>;     // §4.2
  fsWrite(req: FsWriteRequest): Promise<FsWriteResponse>;  // §4.2 — bumps revision, emits fs.changed
  fsDelete(req: FsDeleteRequest): Promise<{ revision: number }>;
  fsSearch(req: FsSearchRequest): Promise<FsSearchResponse>;

  // ---- Git (A2) ----
  gitStatus(req: GitStatusRequest): Promise<GitStatusResponse>;
  gitDiff(req: GitDiffRequest): Promise<GitDiffResponse>;   // §4.3 — porcelain parse → hunks
  gitLog(req: GitLogRequest): Promise<GitLogResponse>;
  gitShow(req: GitShowRequest): Promise<GitShowResponse>;

  // ---- Terminal PTY (A2 control; output emitted on A1) ----
  ptyOpen(req: PtyOpenRequest, openedBy: string): Promise<PtyOpenResponse>;  // §4.5
  ptyWrite(req: PtyWriteRequest): Promise<void>;            // session.writeStdin
  ptyResize(req: PtyResizeRequest): Promise<void>;          // SIGWINCH via stdin escape / exec
  ptyClose(req: PtyCloseRequest): Promise<void>;

  /** Emit A1 events through the same bus path the agent turn uses. */
  private emit(events: { type: SessionEventType; payload: unknown }[]): Promise<void>;
}
```

`emit` calls `appendAndPublishEvents(this.db, this.bus, workspaceId, sessionId, events)` (`packages/events/src/index.ts:30`) — identical to how the agent-turn activity publishes. The A2 service is bound to a `db`+`bus` pair: in the API-direct path that is the API's own `db`+`bus` (already in `dependencies.ts`); on the agent-turn side it is the worker's. Either way FS/Git notifications and PTY output are first-class durable session events, **A1: appended to `session_events` (DB-sequenced) and fanned out worker/API→NATS→SSE→client**, sequenced and replayable, with zero new transport. The A1 emission is the **only** Channel-A use of NATS — the A2 request/response itself never touches NATS.

### 4.2 FileSystem implementation details

- **`fsList`** uses `session.listDir({path})` (`session.d.ts:117`) for one level when available; for `depth>1` it does a **single `exec`** of a bounded `find`-equivalent to avoid N round-trips: ```find <root> -mindepth 1 -maxdepth <depth> -printf '%y\t%s\t%T@\t%m\t%p\0'``` (NUL-delimited, parsed into `FsTreeNode[]`). Falls back to recursive `listDir` if `exec` absent. Enforces `maxEntries`/`maxBytes` caps → sets `truncated`. The probe order is `listDir` (cheap, no shell) for `depth<=1`, `exec`-find for deeper trees.
- **`fsRead`** uses `session.readFile({path, maxBytes})` (`session.d.ts:116`) which returns `string | Uint8Array`. Binary sniff: read first 8 KB, NUL byte present ⇒ `isBinary:true`; base64-encode if `encoding:"base64"` requested or binary detected. `truncated` when `sizeBytes>maxBytes` (a separate `exec stat` gets the true size cheaply). No `readFile`? Fall back to `exec`-ing `base64 -w0 <path> | head -c <cap>`.
- **`fsWrite`/`fsDelete`** use `session.createEditor(runAs?)` → `Editor.createFile/updateFile/deleteFile` (`editor.d.ts:6-14`) with the SDK `ApplyPatchOperation` op. On success: `this.revision++`, then `emit([{type:"fs.changed", payload:{changes:[{path,kind,sizeBytes}], source:"write", revision:this.revision}}])`. **`files:write` permission** gated at the route.
- **`fsSearch`** is a **single `exec`** of ripgrep with `--json` (`rg --json -n --max-count <perFile> ...`) parsed into `FsSearchMatch[]`; fallback `grep -rnI`. `maxResults` cap aborts the rg process (`| head`-style bound or `--max-count` × file budget).

**`runAs` handling:** modal/daytona/cloudflare support it; e2b/runloop/blaxel/vercel throw on `runAs` (SDK survey). The owner omits `runAs` unless the backend is in the supporting set — a per-backend boolean on the owner.

### 4.3 Git implementation — porcelain → structured hunks (the Pierre-diff feed)

All git is `session.exec` of plain git with machine-readable flags, parsed in-worker. Exact command map:

| Service | git invocation (run with `workdir=<repoRoot>`) | parse |
|---|---|---|
| `gitStatus` | `git status --porcelain=v2 --branch -z` | `# branch.*` headers → head/upstream/ahead/behind; `1`/`2`/`u`/`?` records → `GitFileStatus` (XY codes) |
| `gitDiff` (worktree) | `git -c core.quotePath=false diff --no-color --unified=<ctx> -z --numstat` then per-file `git diff --no-color -U<ctx> -- <path>` | numstat → additions/deletions + binary detection; unified patch → `GitDiffHunk[]`/`GitDiffLine[]` via a unified-diff parser |
| `gitDiff` (staged) | add `--cached` | same |
| `gitDiff` (refs) | `git diff <fromRef> <toRef>` | same |
| `gitLog` | `git log --format=%H%x1f%h%x1f%P%x1f%an%x1f%ae%x1f%at%x1f%cn%x1f%ce%x1f%ct%x1f%s%x1f%b%x1e -n<count> --skip=<skip> <ref> -- <pathspec>` | split on `%x1e` records, `%x1f` fields → `GitCommit[]` |
| `gitShow` | `git show --format=... --numstat --patch <ref>` OR `git cat-file blob <ref>:<filePath>` for blob mode | commit + diff vs first parent, or raw blob |

The unified-diff parser converts each `@@ -a,b +c,d @@` hunk into `GitDiffHunk{oldStart,oldLines,newStart,newLines,header,lines}` with `oldNo`/`newNo` line numbers per `GitDiffLine` — **exactly the shape Pierre's diff component consumes** (left/right gutter line numbers + add/del/context typing). Binary/oversized files set `truncated:true` and omit `hunks`. `isImage` is sniffed from extension + git's binary flag (so Pierre can render an image-diff swap).

**Multi-repo:** `path` selects a repo root within the workspace (e.g. `repos/foo`, matching the agent's clone target `/workspace/repos/<repo>`, `runtime/src/index.ts:1883`). `Git.repos` in capabilities is populated by a cached `find <root> -maxdepth 3 -name .git -type d` probe.

### 4.4 Change detection & the `revision` counter

- **FS writes the API-direct service performs** → the service bumps `revision`, emits `fs.changed{source:"write"}` synchronously (the API holds `bus`, so it appends + publishes on A1 in-process).
- **Agent-caused changes** (the turn wrote files via its own tools) → the agent-turn activity runs in the worker and reuses the same service module; it emits `fs.changed{source:"agent"}` after a tool that mutates the FS (best-effort, debounced 250 ms). For v1 this is the pragmatic signal; a true inotify `watch` (an in-box `inotifywait` piped through a long-lived in-box reader whose output is appended to A1) is the **v2 `source:"watch"`** path — the contract already has the field.
- **Git** → after any A2/agent op that could change git state, a debounced (500 ms) `gitStatus` re-probe emits `git.changed` with `reason`. v1 does not watch `.git` via inotify; it re-probes on FS-change-within-a-repo + on PTY-exit (a shell session may have committed).
- `revision` is the cheap client-side cache-invalidation token: a `FsListResponse.revision` lets the client skip re-fetch until the next `fs.changed.revision` exceeds it.

### 4.5 Terminal: the two paths

**Read path (DONE, contract-enriched):** the agent's command output already flows as `sandbox.command.output.delta` (`contracts:1295`, structural in `streaming.ts:11`). This spec only **enriches its payload** to `SandboxCommandOutputDeltaPayload` (stream/chunk/commandId/seq) — a backward-compatible payload widening (consumers read `chunk`). No new transport.

**Interactive PTY (NEW):** the contract is "a pty channel for stdin/resize." Decision — **buffered-exec PTY: control ops are API-direct (A2), output rides A1, NOT a raw pty-ws**, because a raw write-socket bypasses the `approvalQueue`/`interrupt` governance (Ground §J-h security ruling: disable raw-pty write on the *desktop* plane). The four control ops are single-round-trip and served **client → API → box** (the API resumes the box by id in-process and issues the `writeStdin`/`exec`); the long-lived output drain is an **in-box detached reader**, not a worker-held loop. The PTY contract:

1. `POST …/pty` (`ptyOpen`) → **API-direct**: the API resumes the box by id and runs `session.exec({cmd: shell, tty:true, yieldTimeMs: <small>})`, which returns a `SandboxExecResult` carrying `sessionId` (the numeric exec-session, `session.d.ts:55`). The API records `ptyId→sessionId` in `sandbox_pty_sessions` and emits `terminal.pty.started` (A1). The **output drain runs in-box**: a backgrounded reader (`nohup`-detached, same pattern as the desktop chain) tails the pty fd and appends each chunk as `terminal.pty.output.delta{ptyId, chunk, seq}` onto A1 (worker/agent-turn-side `appendAndPublishEvents`, or an in-box agent that posts to the event sink) — so PTY output is durable, sequenced, and NOT tied to any one HTTP request's lifetime. (`writeStdin` returns the accumulated terminal output string — `session.d.ts:114`.)
2. `POST …/pty/write` (`ptyWrite`) → **API-direct** `session.writeStdin({sessionId, chars:data})`; output comes back through the in-box drain as A1 deltas (NOT in the HTTP response — keeps the stream single-ordered).
3. `POST …/pty/resize` (`ptyResize`) → SIGWINCH. SDK has no resize method, so the API-direct handler `exec`s `stty cols <c> rows <r>` against that exec-session, or sends the xterm resize escape. Update `cols/rows` in the row.
4. `POST …/pty/close` → **API-direct**: write EOF/`exit`, mark the row `closed`, emit `terminal.pty.exited` (A1).

**Capability gate:** `supportsPty()===false` (runloop, vercel) ⇒ `ptyOpen` returns `supportsInput:false` and the route 409s on `ptyWrite` — those tiers get the read-only command firehose only. **Security v1:** `terminal:attach` permission required; PTY input is a first-class governed action (it CAN run destructive commands), so it is **opt-in per session** and the writer is the human viewer, not a second agent.

**PTY reaping:** `sandbox_pty_sessions.last_input_at` TTL (~10 min idle) + `lease_epoch` fence. The **one global reaper** (the Temporal Schedule, crosscut module) reaps idle PTYs and PTYs stranded by a box rollover/re-key (emit `pty.exited{reason:"owner_gone"}` — the `owner_gone` reason name is retained as a stable contract literal meaning "the box the PTY was bound to is gone", not an owner-actor reference).

---

## 5. API routes (`apps/api/src/routes/sessions.ts`) + API-direct sandbox wiring (`apps/api/src/dependencies.ts`)

All routes follow the grounded pattern (`sessions.ts`): `requireAccessGrant(c, deps, workspaceId, <perm>)` → `assertSessionExists` → parse contract Zod → **serve API-direct: resume the box by id from the group lease envelope in-process, operate the live `session` handle, return inline JSON**. Per the CORRECTED MODEL the API **gains a sandbox client of its own** — `dependencies.ts` adds one field (a sandbox/Modal client built from settings); it does **not** signal Temporal for these ops and there is no worker RPC.

### 5.1 The API-direct sandbox seam (`apps/api/src/dependencies.ts` + `@opengeni/runtime/sandbox`)

The enabling refactor is a thin shared module. Extract `createSandboxClient`, `deserializeSandboxSessionStateEnvelope`, `restoredSandboxSessionStateFromEntry`, and `sandboxStateEntryFromRunState` into `@opengeni/runtime/sandbox` so `apps/api` imports them **without** dragging in the `@openai/agents` agent-loop graph (verified: the sandbox-client functions have zero coupling to the agent-loop/Temporal/model-provider code; `packages/runtime` has no `@temporalio` dep). Then:

1. Add `@opengeni/runtime` (the `/sandbox` subpath) to `apps/api/package.json`.
2. Plumb the Modal token (already parsed by the shared `getSettings`, `packages/config`) into the API's sandbox-client construction in `dependencies.ts`; confirm API egress to `api.modal.com` (the API already makes outbound HTTPS to Stripe/OpenAI/GitHub).
3. `dependencies.ts` grows from `{db, bus, workflowClient, objectStorage}` to additionally carry a `sandbox` client (or a `resumeBoxById(group)` helper bound to it).

**The A2 request path, end to end (no Temporal, no NATS round-trip):**

```
route handler
  → requireAccessGrant(...)            // auth-per-call
  → assertSessionExists(...)
  → parse Zod body
  → acquire a viewer-kind lease holder + run the cold→warming CAS  // Postgres txn the API OWNS
  → sandbox.resume(envelope.instanceId, deserializeSandboxSessionStateEnvelope(group.envelope))  // by id, in-process, per-call
  → new SandboxChannelAService({ session, db, bus, workspaceId, sessionId }).<fsList|gitDiff|ptyWrite|...>(req)
  → return inline JSON
  → release the viewer-kind holder (delete the holder row); drop the live handle
```

`ModalSandboxClient.resume()` is **per-call with no pool/singleton**, so a burst of FS reads is a burst of cheap resume-by-id calls, each dropping its handle on return — exactly like the API's other outbound clients. The cold→warming lease CAS is the **same Postgres transaction pattern** as `claimNextQueuedTurn` (`db/index.ts:3077`), run from the API. FS/Git point queries target **sub-200 ms**; there is no activity timeout/heartbeat to configure because there is no activity. The single global Temporal Schedule reaper (crosscut module) is the **only** Temporal touch-point for the non-turn lifecycle, and it does the refcount-0 provider terminate + TTL reap out of band — it is never in the synchronous A2 path.

> Why not Temporal here: the earlier draft routed A2 through a short-lived `sandboxOwnerRpcWorkflow` on a per-session/`owner_task_queue` and tried to deliver the reply over a "private RPC-reply event" on NATS. That is **superseded and deleted**: it added a workflow hop + a bus-reply path that violated the event-spine invariants (`SessionEvent.sequence` is required and DB-assigned; SSE has no type-allowlist to drop a reply event), and it was unnecessary — the API can resume the box by id itself. The A2 reply is just the HTTP response.

### 5.2 Route table (all under `/v1/workspaces/:workspaceId/sessions/:sessionId`)

```
# FileSystem (A2)
POST  /fs/list      perm files:read     body FsListRequest    → FsListResponse
POST  /fs/read      perm files:read     body FsReadRequest    → FsReadResponse
POST  /fs/write     perm files:write    body FsWriteRequest   → FsWriteResponse   (emits fs.changed)
POST  /fs/delete    perm files:write    body FsDeleteRequest  → {revision}        (emits fs.changed)
POST  /fs/search    perm files:read     body FsSearchRequest  → FsSearchResponse

# Git (A2, read-only)
POST  /git/status   perm files:read     body GitStatusRequest → GitStatusResponse
POST  /git/diff     perm files:read     body GitDiffRequest   → GitDiffResponse
POST  /git/log      perm files:read     body GitLogRequest    → GitLogResponse
POST  /git/show     perm files:read     body GitShowRequest   → GitShowResponse

# Terminal PTY control (A2; output on A1 SSE)
POST  /pty          perm terminal:attach body PtyOpenRequest  → PtyOpenResponse    (emits terminal.pty.started)
POST  /pty/write    perm terminal:attach body PtyWriteRequest → 204                (output via A1)
POST  /pty/resize   perm terminal:attach body PtyResizeRequest→ 204
POST  /pty/close    perm terminal:attach body PtyCloseRequest → 204                (emits terminal.pty.exited)

# Capabilities (extends the Channel-B handshake route the lease module adds)
GET   /stream-capabilities  perm sessions:read  → { ...DesktopStream, structured: SessionStructuredCapabilities }
```

POST (not GET) for FS/Git reads because the query carries a structured body (paths, globs, refs) and may be large; consistent with the existing `POST …/events` body-parse pattern (`sessions.ts:296`). All are signature-shaped like the existing `PATCH …/turns/:turnId` handler (`sessions.ts:231`).

Output streams (`terminal.*`, `fs.changed`, `git.changed`) require **no new route** — they arrive on the existing SSE endpoint `GET …/events/stream` (`sessions.ts:214`) which the client already holds open. Auth-per-read is the SSE route's `sessions:read` grant.

### 5.3 Failure / status-code matrix

| Condition | HTTP | Body |
|---|---|---|
| No grant / missing permission | 401 / 403 | `requireAccessGrant`/`requirePermission` throw (`access/index.ts:31,48`) |
| Session not found | 404 | `assertSessionExists` |
| Session has no live box (`backend:none`, or cold + acquire failed) | 409 | `{error:{code:"conflict", message:"sandbox not available"}}` |
| Backend lacks the capability (e.g. `pty/write` on runloop) | 409 | `{code:"conflict", message:"interactive terminal unsupported on this backend"}` |
| Path escapes workspace root (`..`, absolute) | 400 | `{code:"validation_failed"}` — the service normalizes + rejects |
| File too large (`> maxBytes` ceiling) | 200 + `truncated:true` | partial content (NOT an error) |
| `fs/write` with `overwrite:false` on existing path | 409 | `{code:"conflict"}` |
| `git/*` outside a repo | 200 | `GitStatusResponse{isRepo:false}` (not an error) |
| API-direct resume/exec times out (box hung) | 504 | `{code:"upstream_unavailable"}` — the in-process resume-by-id or `session.exec` exceeded its deadline |
| Box re-keyed/rolled over mid-PTY (epoch fence) | n/a (async) | `terminal.pty.exited{reason:"owner_gone"}` on A1; next `pty/write` → 409 |
| Binary file as `encoding:utf8` | 200 | `isBinary:true`, content is utf-8-lossy or 422 if client requires text |

---

## 6. SDK propagation (`packages/sdk`)

Per the parity-test rule (`packages/sdk/test/contract-parity.test.ts`):
- `packages/sdk/src/types.ts`: add the 5 new event types to `SESSION_EVENT_TYPES` (`:100`) **in contract order**; add `"files:write"`,`"terminal:attach"` to `KNOWN_PERMISSIONS` (`:249`); add hand-written mirror types for every payload in §2.3 and every request/response in §2.4; add `SessionStructuredCapabilities`.
- `packages/sdk/src/index.ts`: re-export all new types from the `export type {…}` block (`:21`).
- **New SDK client methods** (the SDK is the typed client surface): `fs.list/read/write/delete/search`, `git.status/diff/log/show`, `terminal.openPty/writePty/resizePty/closePty`, `session.capabilities()`. Each is a typed `fetch` to the §5.2 route. The PTY output + `fs.changed`/`git.changed` arrive through the **existing** `useSessionEvents` SSE consumer — no new SDK transport.

---

## 7. React propagation (`packages/react`)

Per the timeline fold pattern (`packages/react/src/timeline.ts:128`):
- **Timeline**: `fs.changed`/`git.changed` are **not** timeline rows (they're cache-invalidation signals) — they feed hooks, not `buildTimeline`. But `terminal.pty.started/output.delta/exited` MAY surface as a `TerminalItem` variant (new entry in the `TimelineItem` union `:113` + `switch` cases `:163`) if the product wants PTY transcripts inline; otherwise they're consumed by a dedicated terminal hook. The existing `sandbox.command.output.delta` already folds into `SandboxItem` (`:331`) — leave it.
- **New hooks** (export from `packages/react/src/index.ts:75`):
  - `useFileTree(sessionId)` — calls `fs.list`, subscribes to `fs.changed`, re-fetches when `revision` advances; returns `FsTreeNode` tree for the **Pierre file tree**.
  - `useFileContent(sessionId, path)` — `fs.read`, invalidates on matching `fs.changed`.
  - `useGitStatus(sessionId, repo)` / `useGitDiff(sessionId, {...})` — `git.status`/`git.diff`, invalidate on `git.changed`; the diff hook returns `GitFileDiff[]` straight into the **Pierre diff** component.
  - `useTerminal(sessionId)` — opens/holds a PTY, feeds `terminal.pty.output.delta` into an xterm.js buffer, sends `pty.write`/`pty.resize`.
  - `useStructuredCapabilities(sessionId)` — `GET /stream-capabilities`, gates which panels render.
- **New component prop contracts** (React, exported from `packages/react/src/index.ts`):

```ts
export interface FileTreeProps {
  sessionId: string;
  tree: FsTreeNode | null;            // from useFileTree
  selectedPath: string | null;
  onSelect(path: string): void;
  onExpand(path: string): void;       // lazy-load children (fs.list depth=1 at path)
  loading: boolean;
  revision: number;
}
export interface FileViewerProps {
  path: string;
  content: string | null;             // from useFileContent
  encoding: "utf8" | "base64";
  isBinary: boolean;
  truncated: boolean;
  readOnly: boolean;                  // from capabilities.FileSystem.readOnly
  onSave?(next: string): void;        // fs.write; only if !readOnly && files:write
}
export interface GitDiffViewerProps {  // wraps Pierre diff
  files: GitFileDiff[];               // from useGitDiff
  loading: boolean;
  onSelectFile(path: string): void;
  contextLines: number;
  onContextChange(n: number): void;
}
export interface TerminalProps {
  sessionId: string;
  ptyId: string | null;
  supportsInput: boolean;             // false on runloop/vercel → read-only xterm
  onData(bytes: string): void;        // pty.write
  onResize(cols: number, rows: number): void;
  buffer: string;                     // accumulated terminal.pty.output.delta
}
```

---

## 8. State machines

### 8.1 PTY lifecycle (per `ptyId`)

```
                  ptyOpen (exec tty:true → sessionId)
   [absent] ───────────────────────────────────────────▶ opening
                                                            │ emit terminal.pty.started
                                                            ▼
            pty/write (writeStdin) ◀───────────────────▶  open  ──── pump emits pty.output.delta (loop)
            pty/resize (stty)      ◀───────────────────▶   │
                                                            │ pty/close | shell exits | TTL idle | owner_gone(epoch)
                                                            ▼
                                                         closing ── emit terminal.pty.exited{reason} ──▶ [closed]
```
- `opening→open`: first successful drain.  
- `open→closing`: explicit close, child `exit`, `last_input_at` TTL (~10 min), or `lease_epoch != current epoch` (box re-key/rollover fence ⇒ `reason:"owner_gone"`).  
- Idempotent close: `ptyClose` on an already-`closed` row is a 204 no-op (status short-circuit, mirrors `failSession` idempotency at `session-state.ts:32`).

### 8.2 FS/Git request (per call, API-direct) — no persistent state

```
   API route handler
       ─▶ acquire viewer-lease-holder + cold→warming CAS (Postgres txn the API owns)
       ─▶ box warm? ──no──▶ resume-by-id from the group envelope (cold-restore), in-process
                       │yes (resume-by-id reattach)
                       ▼
              run session.exec/readFile/createEditor ──err──▶ map to HTTP (§5.3)
                       │ok
                       ▼
              parse → HTTP response  ─▶ release viewer-lease-holder (delete holder row); drop the live handle
```
The viewer-lease-holder is held only for the call (the §B critical-section in the lease module), so a burst of FS reads doesn't keep the box warm beyond the last call's grace window; each call is an independent in-process resume-by-id with no Temporal hop.

### 8.3 `fs.changed`/`git.changed` debounce

```
   write/agent-mutation ─▶ revision++ ─▶ [debounce 250ms FS / 500ms Git] ─▶ coalesce paths ─▶ emit one event
```

---

## 9. Exhaustive failure / edge-case catalog

| # | Case | Handling |
|---|---|---|
| 1 | Box cold when FS read arrives | The API-direct handler runs the cold→warming CAS + `acquireLease(viewer, kind:"viewer")` (lease module §B) and resumes-by-id (cold-restore) in-process; on success serve; on spawn-fail → 409 |
| 2 | Backend `none` | `capabilities()` all `available:false`; routes 409 before touching the box |
| 3 | `supportsPty()===false` (runloop/vercel) | `ptyOpen` → `supportsInput:false`; `pty/write` → 409; client renders read-only terminal |
| 4 | Path traversal (`../`, absolute, symlink escape) | The service normalizes against `workspaceRoot`, rejects → 400; symlink target outside root treated as `type:"other"`, not followed for write |
| 5 | Huge file read | Capped at `maxBytes`; `truncated:true`; never streams the whole thing into an event |
| 6 | Binary file in a utf8 read | NUL-sniff → `isBinary:true`; base64 if requested; viewer shows "binary" |
| 7 | `fs.list` on a 100k-file dir | `maxEntries` cap + `truncated:true` per node and globally; Pierre tree lazy-expands via `onExpand` (depth=1 fetches) |
| 8 | Concurrent writes to same path (two viewers) | Last-writer-wins at the OS level (matches Ground's "concurrent-write conflicts NOT handled"); both get an `fs.changed`; `revision` lets each detect staleness |
| 9 | `git/diff` on a 10 MB generated file | `maxBytesPerFile` → `truncated:true`, `hunks:[]`; Pierre shows "large diff suppressed" |
| 10 | `git/*` in a non-repo workspace | `GitStatusResponse{isRepo:false}`; capabilities `Git.available:false` (no `.git` found) |
| 11 | Git submodules / nested repos | `Git.repos[]` lists each; `path` selects which; status is per-repo |
| 12 | PTY output flood (yes-bomb) | The pump's `maxOutputTokens`/`yieldTimeMs` bound each drain; the batcher (`streaming.ts`, 50 events/33 ms) and SSE backpressure throttle; a per-pty rate cap drops + emits a `[output throttled]` marker delta |
| 13 | Box hangs mid-call | The in-process resume-by-id / `session.exec` exceeds its deadline → API 504; client retries → re-acquires the lease and resumes-by-id again (cold-restore via the lease recovery primitive) |
| 14 | Box re-keyed/rolled over, stale PTY | `lease_epoch` mismatch → `pty.exited{owner_gone}`; client re-opens; `sandbox_pty_sessions` row marked closed by the global reaper |
| 15 | Closed laptop with open PTY | Viewer-holder TTL reaps (~90 s, lease §J-f); idle PTY also TTL-reaped; `pty.exited{owner_gone/timeout}` |
| 16 | SSE gap during a burst of `fs.changed` | The SSE gap-fill (`sse.ts:20`) back-fills from `listSessionEvents` — `fs.changed`/PTY deltas are durable session events, so no loss; client re-lists on the highest `revision` seen |
| 17 | `runAs` on a backend that throws (e2b/runloop/blaxel/vercel) | The service never passes `runAs` for those backends (per-backend flag); single-user semantics |
| 18 | Ripgrep absent in image | `fsSearch` falls back to `grep -rnI`; if both absent → 200 with `matches:[]` + a capability note |
| 19 | `git` absent in image | `Git.available:false`; routes 409 |
| 20 | Two clients open PTYs simultaneously | Each is a distinct `ptyId`/exec-session; independent; both fan out on A1 (the client filters by its `ptyId`) |
| 21 | Editor `createFile` on a path whose parent is missing, `createParents:false` | 409/400 from the editor op → mapped |
| 22 | Modal 24h snapshot-rollover mid-session | Box id changes; open PTYs die (`owner_gone`); FS/Git reads transparently resume-by-id against the rolled-over box (the next A2 call cold-restores from the updated envelope); `revision` resets (clients re-fetch) |
| 23 | Encoding mismatch (client wants utf8, file is latin-1) | Returned as utf-8-lossy with `isBinary:false`; client may re-request `base64` to decode itself |
| 24 | Permission downgrade mid-session (grant revoked) | Next route call → 403; SSE drops on next `requireAccessGrant` re-check; tie-in to holder reap (foundation §J-h) |

---

## 10. Exact file-by-file change list

| File | Change |
|---|---|
| `packages/contracts/src/index.ts` | **(a)** `Permission` (`:57`): add `"files:write"`, `"terminal:attach"`. **(b)** `SessionEventType` (`:1270`): add 5 event types (§2.2). **(c)** add all payload schemas (§2.3) + A2 request/response schemas (§2.4) + `SessionStructuredCapabilities` (§2.5); extend `ClientConfig` (`:1425`) with `structuredServices`. Export all. |
| `packages/sdk/src/types.ts` | Mirror: `SESSION_EVENT_TYPES` (`:100`) +5 in order; `KNOWN_PERMISSIONS` (`:249`) +2; hand-written types for every new payload/request/response; `SessionStructuredCapabilities`. |
| `packages/sdk/src/index.ts` | Re-export new types (`:21`); add client methods `fs.*`, `git.*`, `terminal.*`, `session.capabilities()`. |
| `packages/db/src/schema.ts` | Add `sandbox_pty_sessions` table (§3.1) beside `sandboxSessionEnvelopes` (`:360`). |
| `packages/db/drizzle/00NN_sandbox_pty_sessions.sql` | The CREATE TABLE (§3.1), generated by `drizzle-kit generate` (with the journal entry + `opengeni_app` GRANT). |
| `packages/db/src/index.ts` | Add `insertPtySession`/`closePtySession`/`listOpenPtySessions`/`reapIdlePtySessions` queries (mirror `claimNextQueuedTurn`'s `withWorkspaceRls`+txn pattern). |
| `packages/runtime/src/sandbox/channel-a.ts` (NEW) | The provider-agnostic `SandboxChannelAService`: `capabilities`, `fsList/Read/Write/Delete/Search`, `gitStatus/Diff/Log/Show`, `ptyOpen/Write/Resize/Close`, `emit`, the in-box PTY-drain launcher, the `revision` counter, the unified-diff + porcelain parsers. Operates on a resumed-by-id `{session, db, bus}` triple; **no ownership/singleton**. |
| `packages/runtime/src/sandbox/index.ts` (NEW barrel) | Re-export `createSandboxClient` + `deserializeSandboxSessionStateEnvelope` + `restoredSandboxSessionStateFromEntry` + `sandboxStateEntryFromRunState` (extracted so `apps/api` imports them WITHOUT the `@openai/agents` agent-loop graph) under `@opengeni/runtime/sandbox`. |
| `apps/api/package.json` | Add the `@opengeni/runtime` (`/sandbox` subpath) dependency. |
| `apps/api/src/dependencies.ts` | Construct a sandbox client from settings (Modal token plumbed via `getSettings`); add it (or a `resumeBoxById` helper) to `deps`. **This is the only `dependencies.ts` change — the API now holds a sandbox client.** |
| `apps/api/src/routes/sessions.ts` | Add the 13 routes (§5.2), each `requireAccessGrant` + Zod parse + cold→warming CAS/viewer-holder acquire + **in-process `sandbox.resume()` by id** + `SandboxChannelAService` method + inline JSON; extend the `GET …/stream-capabilities` route with the `structured` block. NO Temporal, NO worker RPC for these routes. |
| `apps/worker/src/activities/agent-turn.ts` | Import the shared `SandboxChannelAService` to emit `fs.changed{source:"agent"}` after agent FS-mutating tools (the agent-turn side already holds a live handle in-process). |
| `apps/worker/src/activities/streaming.ts` | Add `"terminal.pty.output.delta"` to the structural set (`:8`) so PTY bytes flush promptly. |
| `packages/react/src/timeline.ts` | Optional `TerminalItem` variant + `switch` cases for `terminal.pty.*` (`:113`,`:163`); leave `sandbox.command.output.delta` as-is. |
| `packages/react/src/index.ts` | Export new hooks (`useFileTree`/`useFileContent`/`useGitStatus`/`useGitDiff`/`useTerminal`/`useStructuredCapabilities`) + component prop types (§7). |
| `packages/react/src/hooks/*` (NEW) | The hook implementations. |
| `packages/sdk/test/contract-parity.test.ts` | Will fail until sdk mirrors land — drives the parity. |

**No change needed:** `packages/events/src/index.ts` (the `emit` path is reused verbatim), `apps/api/src/http/sse.ts` (gap-fill/replay handle the new event types for free), `packages/db` `session_events` schema (free-text type column), `apps/api/src/index.ts` `SessionWorkflowClient` (the A2 routes do NOT signal Temporal — only the existing turn/interrupt signals stay). The SSE/DB/bus spine is untouched — exactly the Channel-A promise. **Changed (CORRECTED MODEL):** `dependencies.ts` now constructs and holds a sandbox client so A2 routes are served API-direct (the prior "API holds no box client" invariant is intentionally relaxed for the control plane — pixels still go client→Modal-direct, events still ride NATS→SSE).

---

## 11. Key grounded anchors (absolute paths)

- SDK session surface Channel A rides: `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/sandbox/session.d.ts:101-127` (exec :112, writeStdin :114, readFile :116, listDir :117, createEditor :111, supportsPty :125); arg/result shapes :39-81.
- File-edit primitive: `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/shared/editor.d.ts:3-14` (`RemoteSandboxEditor.createFile/updateFile/deleteFile`); IO `…/shared/types.d.ts:5-12`.
- Modal session methods (`exec`/`writeStdin`/PTY `supportsPty=true`): `…/sandbox/modal/sandbox.d.ts` (options :94-115, session class).
- Event spine: `packages/events/src/index.ts:30` (`appendAndPublishEvents`), `:50` (`formatSse`); SSE fan-out + gap-fill `apps/api/src/http/sse.ts:5,20,33,43`.
- Contract source of truth: `packages/contracts/src/index.ts` — `SessionEventType:1270`, `SessionEvent:1306`, existing `sandbox.command.output.delta:1295`, `ClientSessionEvent:1347`, `ClientConfig:1425`, `Permission:57`, `SandboxBackend:13`.
- SDK mirrors: `packages/sdk/src/types.ts` `SESSION_EVENT_TYPES:100`, `KnownSessionEventType:135`, open-union `:141`, payload mirrors `:158`.
- React fold: `packages/react/src/timeline.ts:128` (`buildTimeline`), `SandboxItem:79`, sandbox cases `:301,:331`.
- Route/auth pattern: `apps/api/src/routes/sessions.ts:214` (SSE), `:231` (PATCH turn), `:296` (client events POST); `apps/api/src/access/index.ts:31,48,55`.
- Worker signaling (turn path only — A2 routes do NOT signal Temporal): `apps/api/src/index.ts:45-69` (`SessionWorkflowClient`, `signalWithStart`). The pre-existing memoized `services()` `Map` at `apps/worker/src/activities.ts:30` is the OLD per-session-queue/`SandboxOwner` model the corrected API-direct ruling supersedes — cited only as the seam the refactor removes, not a routing dependency.
- Terminal firehose already structural: `apps/worker/src/activities/streaming.ts:11`.
- Existing per-session envelope/lease precedent: `packages/db/src/schema.ts:360` (`sandboxSessionEnvelopes`), `claimNextQueuedTurn` FOR-UPDATE txn pattern in `packages/db/src/index.ts`.

---

**Net:** Channel A is two transports on one spine. The **terminal-output firehose already exists** (`sandbox.command.output.delta`) and only needs a richer payload. **FileSystem (list/read/write/search), Git (status/diff/log/show → Pierre hunks), and PTY control** are new A2 request/response services served **API-direct** — the `apps/api` process resumes the box by id from the group lease envelope in-process (via the thin `@opengeni/runtime/sandbox` module, no `@openai/agents` agent-loop graph), operates the live `session` handle, and returns inline JSON; **no Temporal, no per-session task queue, no `SandboxOwner` actor, and no NATS round-trip** in this synchronous path (the API now holds a sandbox client of its own). Their *notifications* (`fs.changed`/`git.changed`/`terminal.pty.*`) ride A1 as durable, sequenced, gap-filled session events. The only new persistent state is `sandbox_pty_sessions`; everything else is stateless point queries plus the existing event log. The full contract→sdk→react chain, route table, owner method surface, state machines, 24-case failure catalog, and file-by-file change list are above.

---

## Adversarial Review

## Adversarial review complete. Findings follow, ordered by severity.

# CRITICAL — won't compile/run as specified

**C1. The whole A2 implementation rides `session.exec()`, which no provider implements.** The spec (§1, §4.1, §4.2, §4.3) consumes `session.exec(args): Promise<SandboxExecResult>` and parses `{stdout, stderr, exitCode}`. Verified against all 7 provider sessions (`@openai/agents-extensions@0.11.6/dist/sandbox/*/sandbox.{d.ts,js}`): **not one session class implements `exec()`**. They implement `execCommand(args): Promise<string>` only. The `exec` the grounding cited (`session.d.ts:112`) is an OPTIONAL interface method that the provider sessions never fill; the `exec` in `modal/sandbox.d.ts:36` is on `ModalContainerProcessLike` (the raw Modal SDK process, `exec(command: string[])`), and `runloop/sandbox.js:554` `devbox.cmd.exec` is the underlying Runloop SDK — neither is the session method. Consequence: every `single exec` in the spec (the NUL-delimited `find`, `rg --json`, `git status --porcelain=v2`, the diff numstat/patch, `git log` with `%x1f`/`%x1e`, `stty` resize) has no method to call, and there is no `stdout`/`stderr`/`exitCode` to parse.
   - **Fix:** Build on `execCommand(args): Promise<string>` (the only universal exec). But its return is **not raw output** — see C2. Either (a) capability-probe `Boolean(s.execCommand)` instead of `Boolean(s.exec)` and parse the decorated string, or (b) reach the provider-private raw exec (e.g. modal `this.sandbox.exec`, runloop `devbox.cmd.exec`) which means writing per-provider adapters and abandons the "rides one generic `exec`" claim. The capability probe `Git: { available: Boolean(s.exec) }` (§4.1) will report `false` on every backend.

**C2. `execCommand`/`writeStdin` return a banner-decorated string, not raw bytes — corrupts every parse and the PTY stream.** `formatExecResponse` (`@openai/agents-core/dist/sandbox/shared/output.js:33`) prepends `Chunk ID: …`, `Wall time: N seconds`, `Process running with session ID N` (or `Process exited with code N`), `Original token count: N`, and a literal `Output:` line before the actual output, then truncates to a token budget. So:
   - The PTY pump (§4.5 step 1–2) emits "each returned chunk as `terminal.pty.output.delta{chunk}`" — every drain prepends the banner, so xterm.js receives `Chunk ID: a1b2c3\nWall time: 0.05 seconds\n…\nOutput:\n` interleaved into the terminal byte stream. Garbage.
   - Git porcelain/numstat parsing parses the banner lines as data.
   - **Fix:** there is no clean way to recover raw bytes/exit code from `execCommand`'s string. Use the provider-private process API (modal `this.sandbox.exec(...).stdout`, etc.) per backend, or parse-and-strip the known banner (fragile, and `truncateOutput` may have mangled the payload). This must be resolved before any A2 service works.

**C3. `writeStdin` does not exist on 4 of 7 providers — the PTY pump and `ptyWrite` are uncallable there.** `RemoteSandboxSessionBase` (e2b, runloop, blaxel, vercel) implements no `writeStdin` at all (`shared/sessionBase.js` has none; `grep` finds it only in modal/daytona/cloudflare). On `tty:true` execs the base routes to `execPtyCommand` which throws (`sessionBase.js:65,166`). The spec's capability gate keys PTY on `supportsPty() && writeStdin` for modal/cloudflare (OK) but the §0/§1 matrix lists e2b/blaxel as "⚠️ conditional `writeStdin`" — they have **no** `writeStdin` method, so `Boolean(s.writeStdin)` is `false` and `s.writeStdin(...)` is `undefined is not a function`.
   - **Fix:** PTY is modal/cloudflare/daytona-only via `writeStdin`. For the base-class providers, the real PTY path is the SDK's dedicated abstraction (`shared/pty.d.ts`: `PtyProcessRegistry`, `openPtyWebSocket`, `writePtyStdin`, `collectPtyOutput`) — which the spec never mentions and which is a websocket-to-provider model, not the empty-`writeStdin`-drain model the spec invented. Re-architect PTY on `shared/pty` or restrict PTY to the `writeStdin` providers and mark the rest `pty.available:false` (not "conditional").

**C4. `fsWrite`/`fsDelete` via `createEditor` cannot do raw or binary writes.** §4.2 maps `fsWrite(content)` → `Editor.createFile/updateFile`. But `ApplyPatchOperation` (`@openai/agents-core/dist/types/protocol.d.ts:722-753`) carries `diff: z.ZodString` (a V4A apply-patch diff), and `RemoteSandboxEditor.updateFile` does `applyDiff(current, operation.diff)` (`shared/editor.js:31`), `createFile` does `applyDiff('', diff, 'create')` (`:16`). So:
   - You cannot pass raw `content`; you must synthesize an apply-patch diff. For `update_file` that requires reading current content and computing a diff (a read-modify-write race not handled).
   - `FsWriteRequest` accepts `encoding:"base64"` (binary), but apply-patch diffs are line-oriented text — **binary writes are impossible** through this path.
   - **Fix:** There is no raw-write method on the canonical `SandboxSession` interface across all providers. The provider-private `writeSandboxFile(path, content)` exists on modal/daytona/cloudflare but not on the base providers' public surface. Either drop binary write, accept text-only writes via synthesized full-file diffs (and handle the read-modify-write race + non-existent `overwrite:false`/`createParents` knobs, which `createFile` does not expose), or write per-provider raw-write adapters. The `FsWriteResponse.sizeBytes` is also un-derivable from `ApplyPatchResult` without a follow-up read.

**C5. The §5.1 owner-RPC reply mechanism is broken against the real event spine.** The chosen design (§5.1) delivers the FS/Git result as "a private RPC-reply event … published via `bus.publish` with a reserved internal type, consumed and dropped by SSE … filtered by `rpcId`, not appended to the durable log." Verified against `packages/events/src/index.ts` and `apps/api/src/http/sse.ts`:
   - `EventBus.publish(workspaceId, sessionId, events: SessionEvent[])` requires `SessionEvent` objects, and `SessionEvent.sequence` is `z.number().int().positive()` **required** (`contracts:1309`), DB-assigned. A bus-only message has no sequence.
   - `sseSessionStream` forwards **every** event on the session subject to the client; ordering/gap-fill is driven by `event.sequence` (`sse.ts:18-30`). There is no "reserved internal type, dropped by SSE" filter — the SSE handler has no type allowlist. A sequence-less reply event either crashes the `a.sequence - b.sequence` sort path or leaks to all viewers, and a fabricated sequence corrupts the gap-fill (`listSessionEvents(... event.sequence - lastSent - 1)`).
   - Also, returning a 4 MB `FsReadResponse` over NATS as an "event" is exactly the broadcast-pollution the spec's own §0 says A2 must avoid.
   - **[RESOLVED / SUPERSEDED by the API-direct model]** The original finding correctly killed the event-bus/SSE reply path (a sequence-less reply event crashes the gap-fill sort and pollutes every viewer — that part stands). Its proposed fix — route the reply through Temporal via `WorkflowClient.executeWorkflow(...)` awaiting a `sandboxOwnerRpcWorkflow` return value — is **also superseded** and must not be implemented. Under the finalized control-plane model there is no `SandboxOwner` actor, no per-session task queue, and no RPC workflow: FS reads and Git diffs are **served by the API in-process**. The `apps/api` route resumes the box by id from the group lease envelope (via the thin `@opengeni/runtime/sandbox` module), runs the single `session` read/diff, and **returns the result inline as the HTTP response body** — never via the event bus, never via a Temporal workflow. There is no async reply to correlate, so `rpcId` and the whole reply-routing question disappear. **Resolution:** delete *both* the bus-reply path and the `executeWorkflow`/`sandboxOwnerRpcWorkflow`-await path from §5.1; the A2 request/response services are synchronous API-direct point queries (the API now holds a sandbox client of its own). Notifications (`fs.changed`/`git.changed`/`terminal.pty.*`) still ride A1 as durable sequenced events — only the synchronous *reply* is what goes inline.

# HIGH — architecture/constraint violations & wrong artifacts

**H1. Migration path and format are wrong for this repo.** §3.1/§10 prescribe `packages/db/migrations/NNNN_sandbox_pty_sessions.sql` as a hand-written CREATE TABLE. This repo uses **drizzle-kit**: migrations live in `packages/db/drizzle/` (sequential `0000_…`–`0015_…`), generated by `drizzle-kit generate` from `schema.ts` (`packages/db/drizzle.config.ts`, `out: "./drizzle"`). A hand-written SQL file in a non-existent `migrations/` dir won't be applied and will desync the drizzle meta journal (`packages/db/drizzle/meta`). Also every existing migration includes a `GRANT … TO opengeni_app` RLS block (e.g. `0015_…sql`) the spec omits, so the new table won't be reachable under app-role RLS.
   - **Fix:** Add the Drizzle table to `schema.ts`, run `drizzle-kit generate` (which emits the next `0016_…sql` + meta), and include the `opengeni_app` GRANT.

**H2. `sandbox_pty_sessions` partial-index DDL uses an unqualified `status` and a literal SQL that won't match the Drizzle declaration.** The raw SQL uses `WHERE status = 'open'` and the Drizzle uses `.where(sql\`status = 'open'\`)`. Existing partial indexes in this schema reference the column via interpolation: `.where(sql\`${table.slug} is not null\`)` (`schema.ts:38,158,312`). An unqualified bare `status` works in raw SQL but the convention (and safety against quoting) is `${t.status} = 'open'`. Minor, but it diverges from the established pattern the spec claims to mirror.

**H3. `revision` counter design has an inherent staleness race the spec calls a feature.** §3.2/§4.4: `revision` is a per-owner in-memory counter that "reset to 0 on owner re-election." A client holding `revision=42`, after re-election sees `fs.changed{revision:1}` (lower) and the spec's rule is "skip re-fetch until the next `fs.changed.revision` exceeds [the cached one]" (§4.4) — so the client will **ignore** all post-re-election changes until the counter climbs back above 42, silently serving stale trees. The spec contradicts itself: §3.2 says "a client seeing revision go backwards/jump re-fetches" but §4.4 says skip until it exceeds. 
   - **Fix:** Pair `revision` with the `lease_epoch` (already in `sandbox_leases` per the foundation) so a client invalidates on `(epoch, revision)` tuple change, not a bare monotonic compare. Or seed the counter from a persisted value.

**H4. `git status --porcelain=v2 --branch -z` header/record interleaving + the diff two-pass approach are under-specified and buggy.** §4.3:
   - `--numstat` and `--unified` are **mutually exclusive output modes** in `git diff` for a single invocation. The table's first row `git diff --no-color --unified=<ctx> -z --numstat` then "per-file `git diff …`" conflates them: `--numstat` suppresses the patch, so the first command yields only numstat, and the spec's claim that it produces both is wrong; the per-file second pass is what actually yields hunks. Workable but the table is misleading and the `-z` with `--numstat` changes the field delimiters (NUL between path fields, used for rename `\0old\0new`), which the parser must special-case — unspecified.
   - For renames, `--numstat -z` emits `old\0new` as two NUL fields for that one record, desyncing a naive NUL split. Unspecified.
   - **Fix:** Specify two separate passes explicitly (numstat pass for stats/binary detection; patch pass per file for hunks), and specify the `-z` rename field handling.

**H5. `runAs` matrix contradicts the SDK.** §0/§4.2 say modal/daytona/cloudflare support `runAs` and e2b/runloop/blaxel/vercel "throw." Verified vercel throws (`vercel/sandbox.js:69,973`), and the base providers assert-unsupported. But the spec also says the owner "omits `runAs` unless the backend is in the supporting set — a per-backend boolean on the owner." There's no such per-backend table specified, and the FS/Editor paths in the base class call `assertFilesystemRunAs` even for `runAs:undefined` (`sessionBase.js:103`) — passing `undefined` is fine, but the spec never defines where this per-backend boolean comes from (it's not on the lease, not in config). Loose end, not load-bearing, but "the owner omits `runAs`" needs a concrete source.

**H6. `FsReadResponse.truncated`/`sizeBytes` cannot be derived as described.** §4.2: "`truncated` when `sizeBytes>maxBytes` (a separate `exec stat` gets the true size cheaply)." But `exec`/`exec stat` doesn't exist (C1), and `readFile(maxBytes)` silently truncates via `bytes.subarray(0, maxBytes)` (`sessionBase.js:108-110`) returning exactly `maxBytes` with **no signal** that more existed. So you cannot tell truncated-vs-exactly-maxBytes without a second size probe, and the only size probe is a shell `stat` through the broken exec path.
   - **Fix:** depends on resolving C1/C2; otherwise `truncated` is unreliable.

# MEDIUM — gaps & inconsistencies

**M1. Failure-matrix body shapes don't match the codebase.** §5.3 claims 401/403/404 return `{error:{code:...}}` and "validation_failed"/"conflict" envelopes. But `requireAccessGrant`/`requirePermission` throw `HTTPException(401/403/404, {message})` (`access/index.ts:31-52`) — a plain Hono message, not the structured `{error:{code}}` envelope. The spec's error contract is invented; either the routes must catch-and-reshape, or the matrix is wrong.

**M2. `GET /stream-capabilities` return type conflicts with `ClientConfig`.** §2.5 extends `ClientConfig` with `structuredServices`, but §5.2 says `GET /stream-capabilities` returns `{...DesktopStream, structured: SessionStructuredCapabilities}`. `ClientConfig` (`contracts:1425`) is the deployment-wide config object (`deploymentRevision`, `allowedModels`, …) returned by a different route; bolting `structuredServices` onto it is server-wide, while the per-session capabilities are a separate object. The spec acknowledges the split but then the route shape doesn't reference `ClientConfig` at all — the `structuredServices` extension to `ClientConfig` is never actually consumed by any route in the spec. Dead field or missing route.

**M3. `terminal.pty.output.delta` ordering claim vs the batcher.** §2.3 says `seq` is "strict per-pty ordering (the box assigns)", but the PTY pump (§4.5) gets output from `writeStdin` drains in the worker; the box (Modal `activeProcess`) does not assign a per-pty sequence — the owner must. And §9 case 12 relies on `streaming.ts` batching (50 events/33 ms) which **reorders nothing** but coalesces; however `terminal.pty.output.delta` is added to the structural set (§10) so it flushes immediately — fine — but then `seq` must be owner-assigned, contradicting "the box assigns." Minor contract-comment error.

**M4. `fsList` `depth>1` via `find -printf` is GNU-find-specific.** §4.2 uses `find … -printf '%y\t%s\t%T@\t%m\t%p\0'`. `-printf` is a GNU findutils extension; BusyBox/Alpine/macOS `find` lacks it. The desktop image is Ubuntu (GNU find, OK) but the headless images and non-Ubuntu providers aren't guaranteed GNU find. Unspecified fallback beyond "recursive `listDir`" — and `listDir` doesn't exist either (it's not implemented by any provider session; see the method enumeration). So `fsList` has no working primitive on any backend.
   - **Fix:** `listDir` is unimplemented across all 7 providers (only `pathExists`/`readFile`/`createEditor`/`execCommand` exist). The capability probe `hasFs = Boolean(s.readFile && s.listDir && s.createEditor)` (§4.1) is `false` everywhere because `s.listDir` is always undefined. FileSystem.available would be hardcoded false. This is nearly as severe as C1 — promote if `listDir` truly never appears (verified: it appears in no provider `.d.ts`).

**M5. `sandbox_pty_sessions.opened_by uuid NOT NULL` but the grant/subject may not be a UUID.** `opened_by` is typed `uuid` and commented "viewer grant/subject that opened it." Access subjects in this codebase can be bootstrap/local subjects; if any subject id isn't a UUID, the insert fails. Unverified but worth pinning to the actual `access` subject id type before declaring `uuid NOT NULL`.

**M6. No `pty/read` or initial-buffer replay for a late PTY viewer.** PTY output rides A1 as durable events (good), but a viewer that opens the file-tree panel and *then* attaches to an already-open PTY (opened by another viewer, §9 case 20) has no way to get the scrollback — `terminal.pty.output.delta` events are in `session_events` and replayable via SSE gap-fill, but the spec's `useTerminal` "opens/holds a PTY" (always a fresh open) and never replays an existing `ptyId`'s backlog. The reattach story (the whole point of persisting `sandbox_pty_sessions`) has no read path. Gap.

**M7. `git log` pretty-format with `%x1e`/`%x1f` plus `%b` (body) can contain those bytes.** Extremely rare, but a commit body containing `\x1e`/`\x1f` desyncs the record/field split. Standard mitigation (`-z` NUL-terminated `--format` is not supported; people use it anyway) — at minimum note the risk. Minor.

**M8. PTY `resize` via `stty cols/rows` won't reach the child's controlling TTY.** §4.5 step 3: "owner `exec`s `stty cols <c> rows <r>` inside that exec-session." A separate `execCommand` runs in a *different* process/PTY than the interactive shell's exec-session; `stty` in process B does not resize process A's TTY, and there's no `writeStdin`-side resize escape that portably triggers SIGWINCH. SDK exposes no resize. So resize is effectively unimplementable through this model; the SDK's `shared/pty` websocket path is the only one that could carry a resize frame. Gap — `pty/resize` returning 204 while doing nothing is a silent no-op.

# LOW — cosmetic / line-cite drift

- **L1.** §10 cites `streaming.ts:8`/`:11` for the structural set; it's actually lines 7–18 and `sandbox.command.output.delta` is already at line 10. Action (add `terminal.pty.output.delta`) is valid; cites are off by a couple lines.
- **L2.** §2.2 "older SDKs tolerate these — non-breaking" is correct (`SessionEventType = Known | (string & {})` open union verified at `sdk/types.ts:141`), but the parity test (`contract-parity.test.ts`) will still fail until the SDK mirror lands, which the spec does call out — consistent.
- **L3.** `TerminalPtyOutputDeltaPayload.ptyId: z.string().uuid()` on every delta is wasteful (36 bytes/frame on a high-rate firehose); fine functionally.
- **L4.** §0 table says A1 terminal output is "already `sandbox.command.output.delta`" — true, but that event's existing payload is `{name, chunk}` shape folded by `SandboxItem` (`timeline.ts:331`), and §4.5 "backward-compatible payload widening" to `SandboxCommandOutputDeltaPayload{stream,chunk,commandId,seq}` drops `name`; verify the existing producer/consumer to avoid breaking the current `findOpenSandbox(name)` correlation (`timeline.ts:517`).

# Net assessment

The spec's transport split (A1 events vs A2 request/response), the routing constraint (API holds no box client → Temporal per-session queue), the DB-minimalism (one `sandbox_pty_sessions` table), and the capability-handshake framing are all sound and correctly grounded. **But the entire A2 service layer is built on three SDK methods that don't exist or don't behave as assumed across the providers:** `session.exec()` (unimplemented — only `execCommand` returning banner-wrapped strings), `session.listDir()` (unimplemented on all 7), and raw/binary file writes via `createEditor` (apply-patch-diff only, no binary). PTY rides `writeStdin` which is absent on 4/7 providers, and the spec ignores the SDK's actual `shared/pty` websocket abstraction. The §5.1 owner-RPC reply contradicts itself and, in its bus-published form, violates the event-spine invariants (required DB sequence, no SSE type filter). And the migration is specified in the wrong tool/format/path for this repo. C1–C5 and H1 must be resolved before this is implementable; M4 (`listDir`) should likely be promoted to critical.

Key evidence files (absolute):
- `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/shared/sessionBase.{d.ts,js}` (base providers: no `exec`, no `writeStdin`, no `listDir`; `execPtyCommand` throws)
- `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/modal/sandbox.{d.ts,js}` (only `execCommand`/`writeStdin`/`readFile`/`pathExists`; `writeStdin` returns banner string)
- `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/sandbox/shared/output.js:33` (`formatExecResponse` banner)
- `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/shared/editor.js:11-36` + `/home/jorge/.bun/install/cache/@openai/agents-core@0.11.6@@@1/dist/types/protocol.d.ts:722-753` (apply-patch `diff` strings, not raw content)
- `/home/jorge/.bun/install/cache/@openai/agents-extensions@0.11.6@@@1/dist/sandbox/shared/pty.d.ts` (the real PTY abstraction the spec ignores)
- `/home/jorge/repos/Cloudgeni-ai/opengeni/.claude/worktrees/naughty-engelbart-2d3b09/packages/events/src/index.ts` + `apps/api/src/http/sse.ts` (no bus-only reply path; sequence required; no SSE type filter)
- `packages/db/drizzle.config.ts` + `packages/db/drizzle/0015_*.sql` (drizzle-kit, not `migrations/NNNN_*.sql`; RLS GRANT required)
- `apps/api/src/access/index.ts:31-57` (`HTTPException(…,{message})`, not `{error:{code}}`)
