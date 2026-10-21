/* ----------------------------------------------------------------------------
   M7 full-dock state matrix — fixtures + a state-driven mock client.

   The M5/M6 harnesses render sub-components (WorkbenchChanges, FileBrowser,
   SandboxTerminal) in isolation. M7 reviews the WHOLE dock — frame + header +
   machine chip + activity rail + every surface — in each state of the
   matrix. This module drives the real `<SandboxWorkspace>` through a mock client
   whose capability / capture / machine / git responses are chosen by a state key,
   so one harness + one screenshot runner covers every matrix cell.

   Each state configures what the dock's hooks read:
     - getStreamCapabilities → liveness + which tabs light up (permission-gating)
     - getWorkspaceCapture   → the cold-paint source (manifest w/ per-repo diff)
     - listMachines          → the header chip (online / offline / reconnecting)
     - gitStatus / gitDiff   → the live (warm) diff
   -------------------------------------------------------------------------- */

import type {
  FsTreeNode,
  GetWorkspaceCaptureResponse,
  GitDiffHunk,
  GitDiffLine,
  GitFileDiff,
  GitStatusResponse,
  SessionCapabilities,
  SessionEvent,
  SessionEventListOptions,
  SessionEventPage,
  WorkspaceCaptureManifest,
} from "@opengeni/sdk";
import type { MachinesResponse, MachineView } from "@opengeni/react/machines";
import { isPresentedSessionToolName } from "@opengeni/sdk";
import { MockOpenGeniClient } from "./mock";

export const DOCK_SESSION_ID = "9c1d2e3f-4a5b-4c6d-8e7f-0a1b2c3d4e5f";
const CAPTURED_AT = new Date(Date.now() - 6 * 60_000).toISOString();

// ── diff builders ────────────────────────────────────────────────────────────

function hunk(startAt: number, addLines: number, ctx = 2): GitDiffHunk {
  const lines: GitDiffLine[] = [];
  for (let i = 0; i < ctx; i++)
    lines.push({
      type: "context",
      oldNo: startAt + i,
      newNo: startAt + i,
      text: `  const keep_${i} = ${i};`,
    });
  for (let i = 0; i < addLines; i++) {
    lines.push({
      type: "del",
      oldNo: startAt + ctx + i,
      newNo: null,
      text: `  const removed_${i} = "old value ${i}";`,
    });
    lines.push({
      type: "add",
      oldNo: null,
      newNo: startAt + ctx + i,
      text: `  const added_${i} = "new value ${i}";`,
    });
  }
  for (let i = 0; i < ctx; i++)
    lines.push({
      type: "context",
      oldNo: startAt + ctx + addLines + i,
      newNo: startAt + ctx + addLines + i,
      text: `  return added_${i};`,
    });
  return {
    oldStart: startAt,
    oldLines: ctx + addLines,
    newStart: startAt,
    newLines: ctx + addLines * 2,
    header: `@@ -${startAt},${ctx + addLines} +${startAt},${ctx + addLines * 2} @@`,
    lines,
  };
}

function file(
  path: string,
  add: number,
  del: number,
  hunks: GitDiffHunk[],
  overrides: Partial<GitFileDiff> = {},
): GitFileDiff {
  return {
    path,
    oldPath: null,
    status: "modified",
    isBinary: false,
    isImage: false,
    additions: add,
    deletions: del,
    truncated: false,
    hunks,
    ...overrides,
  };
}

/** The canonical small review: a security hardening across api + infra. */
const diffReview: GitFileDiff[] = [
  file("apps/api/src/server.ts", 6, 2, [
    {
      oldStart: 12,
      oldLines: 4,
      newStart: 12,
      newLines: 6,
      header: "@@ -12,4 +12,6 @@ export function createServer() {",
      lines: [
        { type: "context", oldNo: 12, newNo: 12, text: "  const app = express();" },
        { type: "del", oldNo: 13, newNo: null, text: "  app.use(cors());" },
        {
          type: "add",
          oldNo: null,
          newNo: 13,
          text: "  app.use(cors({ origin: ALLOWED_ORIGINS }));",
        },
        { type: "add", oldNo: null, newNo: 14, text: "  app.use(helmet());" },
        { type: "add", oldNo: null, newNo: 15, text: "  app.use(rateLimit());" },
        { type: "context", oldNo: 14, newNo: 16, text: "  return app;" },
      ],
    },
  ]),
  file("infra/main.tf", 2, 0, [
    {
      oldStart: 4,
      oldLines: 2,
      newStart: 4,
      newLines: 4,
      header: '@@ -4,2 +4,4 @@ resource "aws_instance" "api" {',
      lines: [
        { type: "context", oldNo: 4, newNo: 4, text: '  instance_type = "t3.small"' },
        { type: "add", oldNo: null, newNo: 5, text: "  monitoring    = true" },
        { type: "add", oldNo: null, newNo: 6, text: "  ebs_optimized = true" },
        { type: "context", oldNo: 5, newNo: 7, text: "  tags = local.tags" },
      ],
    },
  ]),
  file(
    "apps/api/src/config.ts",
    3,
    0,
    [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 3,
        header: "@@ -0,0 +1,3 @@",
        lines: [
          { type: "add", oldNo: null, newNo: 1, text: "export const ALLOWED_ORIGINS = [" },
          { type: "add", oldNo: null, newNo: 2, text: '  "https://app.acme.dev",' },
          { type: "add", oldNo: null, newNo: 3, text: "];" },
        ],
      },
    ],
    { status: "added" },
  ),
];

/** A 40-file changeset for the dense / windowing review state. */
function diffDense(count: number): GitFileDiff[] {
  const dirs = [
    "apps/api/src",
    "apps/web/src/components",
    "packages/core/lib",
    "packages/db/migrations",
    "docs",
  ];
  return Array.from({ length: count }, (_, i) => {
    const directory = dirs[i % dirs.length];
    const size = 1 + (i % 5);
    return file(`${directory}/module-${String(i).padStart(3, "0")}.ts`, size * 2, size, [
      hunk(1, size),
    ]);
  });
}

/** A changeset that trips the per-file guards (binary + over-cap). */
const diffGuard: GitFileDiff[] = [
  file("src/index.ts", 4, 1, [hunk(1, 2)]),
  file("assets/logo.png", 0, 0, [], { isBinary: true, isImage: true, status: "modified" }),
  file("data/fixtures.json", 0, 0, [], { truncated: true, additions: 12000, deletions: 8000 }),
];

/** Unicode, spaces, a near-boundary component, and a pathological code line. */
const longComponent =
  "internationalisation-accessibility-observability-and-deployment-coordination-" +
  "with-a-deliberately-long-but-valid-component-name.tsx";
const longPath = `apps/web/src/features/naïve café/日本語/مرحبا/${longComponent}`;
const diffContentStress: GitFileDiff[] = [
  file(longPath, 3, 1, [
    {
      oldStart: 98,
      oldLines: 2,
      newStart: 98,
      newLines: 4,
      header: "@@ -98,2 +98,4 @@ export function buildInternationalisedDeploymentSummary() {",
      lines: [
        { type: "context", oldNo: 98, newNo: 98, text: "  const summary = createSummary();" },
        { type: "del", oldNo: 99, newNo: null, text: "  return summary;" },
        {
          type: "add",
          oldNo: null,
          newNo: 99,
          text: `  const labels = { ${'"localised-observability-label":"value",'.repeat(12)} };`,
        },
        { type: "add", oldNo: null, newNo: 100, text: "  summary.attach(labels);" },
        { type: "add", oldNo: null, newNo: 101, text: "  return summary;" },
      ],
    },
  ]),
  file("packages/runtime/src/paths/old service → replacement service.ts", 0, 0, [], {
    oldPath: "packages/runtime/src/paths/legacy service.ts",
    status: "renamed",
  }),
  file("docs/release notes/résumé · 日本語 · مرحبا.md", 1, 0, [hunk(1, 1)], {
    status: "added",
  }),
];

// ── tree builders ────────────────────────────────────────────────────────────

function dir(name: string, path: string, children?: FsTreeNode[]): FsTreeNode {
  return {
    name,
    path,
    type: "dir",
    sizeBytes: null,
    mtimeMs: null,
    mode: null,
    truncated: false,
    ...(children ? { children } : {}),
  };
}
function fsfile(name: string, path: string, sizeBytes = 512): FsTreeNode {
  return {
    name,
    path,
    type: "file",
    sizeBytes,
    mtimeMs: Date.now(),
    mode: 0o644,
    truncated: false,
  };
}

/** A realistic project tree for the capture index (cold Files tab). */
const treeReview: FsTreeNode = dir("", "", [
  dir("node_modules", "node_modules", []),
  dir(".git", ".git", []),
  dir("apps", "apps", [
    dir("api", "apps/api", [
      dir("src", "apps/api/src", [
        fsfile("server.ts", "apps/api/src/server.ts", 3120),
        fsfile("config.ts", "apps/api/src/config.ts", 640),
        fsfile("routes.ts", "apps/api/src/routes.ts", 2210),
      ]),
      fsfile("package.json", "apps/api/package.json", 842),
    ]),
    dir("web", "apps/web", [
      dir("src", "apps/web/src", [fsfile("main.tsx", "apps/web/src/main.tsx", 1280)]),
    ]),
  ]),
  dir("infra", "infra", [
    fsfile("main.tf", "infra/main.tf", 1860),
    fsfile("variables.tf", "infra/variables.tf", 420),
  ]),
  fsfile("package.json", "package.json", 842),
  fsfile("README.md", "README.md", 1280),
]);

const treeContentStress: FsTreeNode = dir("", "", [
  dir("naïve café", "naïve café", [
    dir("日本語", "naïve café/日本語", [
      dir("مرحبا", "naïve café/日本語/مرحبا", [fsfile(longComponent, longPath, 8192)]),
    ]),
  ]),
  dir("release notes with spaces", "release notes with spaces", [
    fsfile(
      "résumé · 日本語 · مرحبا.md",
      "release notes with spaces/résumé · 日本語 · مرحبا.md",
      4096,
    ),
  ]),
]);
// The residue dirs are collapsed truncated nodes (never descended cold).
(treeReview.children![0] as FsTreeNode).truncated = true;
(treeReview.children![1] as FsTreeNode).truncated = true;

/** A dense capture tree: many modules + collapsed residue. */
function treeDense(dirs: number, filesPer: number): FsTreeNode {
  const roots: FsTreeNode[] = [
    { ...dir("node_modules", "node_modules", []), truncated: true },
    { ...dir(".git", ".git", []), truncated: true },
  ];
  for (let d = 0; d < dirs; d++) {
    const base = `src/module-${String(d).padStart(2, "0")}`;
    const children = Array.from({ length: filesPer }, (_, f) =>
      fsfile(
        `file-${String(f).padStart(3, "0")}.ts`,
        `${base}/file-${String(f).padStart(3, "0")}.ts`,
      ),
    );
    roots.push(dir(`module-${String(d).padStart(2, "0")}`, base, children));
  }
  return dir("", "", roots);
}

// ── capability + machine + capture builders ──────────────────────────────────

/** A full warm-box capability advertisement; overrides narrow specific cells. */
function caps(
  liveness: SessionCapabilities["liveness"],
  overrides: Partial<SessionCapabilities> = {},
): SessionCapabilities {
  return {
    sessionId: DOCK_SESSION_ID,
    backend: "modal",
    os: "linux",
    liveness,
    leaseEpoch: 1,
    workspaceGeneration: null,
    archiveGeneration: null,
    archiveComplete: false,
    viewerHeartbeatIntervalMs: 30_000,
    FileSystem: {
      available: true,
      readOnly: false,
      root: "/workspace",
      pathSep: "/",
      treeMode: "lazy",
      reason: null,
    },
    Terminal: {
      transport: "pty-ws",
      ptyCapable: true,
      shell: "/bin/bash",
      url: null,
      token: null,
      expiresAt: null,
      reason: null,
    },
    Git: { available: true, repos: ["."], reason: null },
    DesktopStream: {
      transport: "vnc-ws",
      client: "novnc",
      mode: "interactive",
      url: "https://desktop.invalid/vnc",
      token: null,
      expiresAt: null,
      resolution: [1024, 768],
      unredacted: true,
      requiresAcknowledgment: false,
      acknowledged: true,
      shared: false,
      sharedSessionIds: [],
      reason: null,
    },
    Recording: { available: false, modes: [], codecs: [], reason: "tier_headless" },
    ComputerUse: { available: false, readOnly: true, reason: "tier_headless" },
    negotiatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A cold lease: FS/Git/Terminal feasible-but-cold, no live desktop. */
function capsCold(overrides: Partial<SessionCapabilities> = {}): SessionCapabilities {
  return caps("cold", {
    Terminal: {
      transport: "sse-events",
      ptyCapable: false,
      shell: "/bin/bash",
      url: null,
      token: null,
      expiresAt: null,
      reason: "lease_cold",
    },
    DesktopStream: {
      transport: null,
      client: null,
      mode: "read-only",
      url: null,
      token: null,
      expiresAt: null,
      resolution: [1024, 768],
      unredacted: false,
      requiresAcknowledgment: true,
      acknowledged: false,
      shared: false,
      sharedSessionIds: [],
      reason: "lease_cold",
    },
    ...overrides,
  });
}

function machine(overrides: Partial<MachineView>): MachineView {
  return {
    sandboxId: "demo-sandbox",
    enrollmentId: null,
    name: "Cloud sandbox",
    kind: "modal",
    state: "online",
    workspaceGeneration: null,
    archiveGeneration: null,
    archiveComplete: false,
    active: true,
    isSessionGroup: true,
    os: "linux",
    arch: "x86_64",
    hasDisplay: true,
    allowScreenControl: false,
    sharedSessionCount: 1,
    lastSeenAt: new Date().toISOString(),
    connectionAuthority: {
      state: "not_applicable",
      generation: 0,
      supersededCount: 0,
      leaseExpiresAt: null,
      duplicateRunnerDeniedCount: 0,
      duplicateRunnerDeniedAt: null,
    },
    runtime: null,
    metrics: null,
    ...overrides,
    scope: overrides.scope ?? "workspace",
    generation: overrides.generation ?? 1,
    operationPolicy: overrides.operationPolicy ?? null,
  };
}
function fleet(m: MachineView): MachinesResponse {
  return { activeSandboxId: m.sandboxId, activeEpoch: 1, machines: [m] };
}

function statsFor(diff: GitFileDiff[], revision: number): WorkspaceCaptureManifest["stats"] {
  const additions = diff.reduce((n, f) => n + f.additions, 0);
  const deletions = diff.reduce((n, f) => n + f.deletions, 0);
  return {
    repoCount: 1,
    fileCount: diff.length,
    additions,
    deletions,
    totalBytes: diff.length * 512,
    tooLargeCount: diff.filter((f) => f.truncated).length,
    binaryCount: diff.filter((f) => f.isBinary).length,
    treeEntryCount: 24,
    treeTruncated: false,
    durationMs: 120,
    fingerprint: `fp-${revision}`,
  };
}

function manifest(
  diff: GitFileDiff[],
  tree: FsTreeNode,
  revision: number,
): WorkspaceCaptureManifest {
  return {
    version: 1,
    revision,
    capturedAt: CAPTURED_AT,
    turnId: `turn-${revision}`,
    leaseEpoch: 1,
    treeIndex: tree,
    treeTruncated: false,
    repos: [
      {
        root: "",
        head: "feat/security-hardening",
        detached: false,
        upstream: "origin/feat/security-hardening",
        ahead: 2,
        behind: 1,
        status: [],
        diff,
      },
    ],
    files: diff.map((f) => ({
      path: f.path,
      status: f.status,
      hash: null,
      baseHash: null,
      contentRef: null,
      sizeBytes: 512,
      isBinary: f.isBinary,
      tooLarge: f.truncated,
      deleted: false,
    })),
    stats: statsFor(diff, revision),
  };
}
function captureAvailable(m: WorkspaceCaptureManifest): GetWorkspaceCaptureResponse {
  return {
    available: true,
    revision: m.revision,
    capturedAt: m.capturedAt,
    turnId: m.turnId,
    leaseEpoch: m.leaseEpoch,
    sizeBytes: 4096,
    stats: m.stats,
    manifest: m,
    manifestUrl: null,
  };
}
const captureNone: GetWorkspaceCaptureResponse = { available: false };

// Valid 64×64 blue/green PNG: browser coverage must decode real raster bytes, not merely
// find an <img> whose source happens to have an image MIME type.
const recoveryPng =
  "iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAIAAAAlC+aJAAAAgklEQVR4nO3YQQ0AMAhDUZRM3YQhZyIQMw0censJBghQ2l91J1rndbRKAyZghRwxFSKjHplPzEowc9woOy3QSGQipVCPSsAqwBYyBy2Cu+j0Gq/H+X0YXWrABKyQI6ZCZNQj84lZCWaOG2WnBRqJTKQU6lEJWAXYQuagRXAXnZ7tGXyehjFL36VnmwAAAABJRU5ErkJggg==";
const recoveryTree = dir("workspace", "", [fsfile("recovery.png", "recovery.png", 187)]);

function status(files: GitStatusResponse["files"], isRepo = true): GitStatusResponse {
  return {
    isRepo,
    head: "feat/security-hardening",
    detached: false,
    upstream: "origin/feat/security-hardening",
    ahead: 2,
    behind: 1,
    files,
    revision: 1,
  };
}
const statusReview = status([
  {
    path: "apps/api/src/server.ts",
    oldPath: null,
    index: null,
    worktree: "modified",
    isConflicted: false,
  },
  { path: "infra/main.tf", oldPath: null, index: null, worktree: "modified", isConflicted: false },
  {
    path: "apps/api/src/config.ts",
    oldPath: null,
    index: null,
    worktree: "added",
    isConflicted: false,
  },
]);
const statusClean: GitStatusResponse = {
  ...status([]),
  head: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
};

// ── the state matrix ─────────────────────────────────────────────────────────

export type DockState = {
  /** Human label for the evidence index. */
  label: string;
  /** getStreamCapabilities response, or "error" to reject (the degraded path). */
  capabilities: SessionCapabilities | "error";
  capture: GetWorkspaceCaptureResponse;
  machines: MachinesResponse;
  gitStatus: GitStatusResponse;
  gitDiff: GitFileDiff[];
  /** fsList root (warm live tree). Capture states read the manifest treeIndex. */
  tree?: FsTreeNode;
  /** fileCount seeded into a `workspace.revision.captured` announce so the
   *  pre-paint default tab resolves correctly (>0 → Changes, 0/absent → Files). */
  announceFileCount?: number;
  /** First attach fails; a second explicit intent recovers the live PNG. */
  liveFileWakeRecovery?: boolean;
  /**
   * A reloaded session with terminal history: past turns' command output and
   * an interactive PTY's scrollback, served with the server's history filters
   * (conversation reads exclude it; the dock reads it by type).
   */
  terminalHistory?: boolean;
};

export const DOCK_STATES: Record<string, DockState> = {
  "capture-unavailable": {
    label: "Cold · saved changes preview unavailable",
    capabilities: capsCold(),
    capture: {
      available: false,
      degradedReason: "repository_read_unavailable",
      revision: 8,
      capturedAt: CAPTURED_AT,
      turnId: "turn-8",
      leaseEpoch: 1,
    },
    machines: fleet(machine({ state: "offline", active: false })),
    gitStatus: statusClean,
    gitDiff: [],
  },
  "live-file-wake-recovery": {
    label: "Live file · failed wake recovery",
    capabilities: capsCold(),
    capture: captureAvailable(manifest([], recoveryTree, 7)),
    machines: fleet(machine({ state: "offline", active: false })),
    gitStatus: statusClean,
    gitDiff: [],
    tree: recoveryTree,
    liveFileWakeRecovery: true,
  },
  // Warm box, live diff, everything lit. The happy path.
  "warm-live": {
    label: "Warm · live",
    capabilities: caps("warm"),
    capture: captureNone,
    machines: fleet(machine({ state: "online" })),
    gitStatus: statusReview,
    gitDiff: diffReview,
    tree: treeReview,
    announceFileCount: 3,
  },
  // Cold box, capture-served instant paint. Machine offline, "as of" labels.
  "cold-instant": {
    label: "Cold · capture-served",
    capabilities: capsCold(),
    capture: captureAvailable(manifest(diffReview, treeReview, 7)),
    machines: fleet(machine({ state: "offline", active: false })),
    gitStatus: statusReview,
    gitDiff: diffReview,
    announceFileCount: 3,
  },
  // A reloaded chat: the box sleeps, and the Terminal shows past command
  // output and PTY scrollback read from history when it opens.
  "terminal-history": {
    label: "Reloaded · terminal history",
    capabilities: capsCold(),
    capture: captureAvailable(manifest(diffReview, treeReview, 7)),
    machines: fleet(machine({ state: "offline", active: false })),
    gitStatus: statusReview,
    gitDiff: diffReview,
    announceFileCount: 3,
    terminalHistory: true,
  },
  // Actively warming: machine reconnecting → chip "Waking…".
  waking: {
    label: "Waking (background)",
    capabilities: capsCold(),
    capture: captureAvailable(manifest(diffReview, treeReview, 7)),
    machines: fleet(machine({ state: "reconnecting", active: true })),
    gitStatus: statusReview,
    gitDiff: diffReview,
    announceFileCount: 3,
  },
  // Self-hosted machine offline: read-only, honest stale label, no terminal/desktop.
  "selfhosted-offline": {
    label: "Self-hosted · offline",
    capabilities: capsCold({
      FileSystem: {
        available: true,
        readOnly: true,
        root: "/workspace",
        pathSep: "/",
        treeMode: "lazy",
        reason: "agent_offline",
      },
      Terminal: {
        transport: null,
        ptyCapable: false,
        shell: "/bin/bash",
        url: null,
        token: null,
        expiresAt: null,
        reason: "agent_offline",
      },
      DesktopStream: {
        transport: null,
        client: null,
        mode: "read-only",
        url: null,
        token: null,
        expiresAt: null,
        resolution: [1024, 768],
        unredacted: false,
        requiresAcknowledgment: true,
        acknowledged: false,
        shared: false,
        sharedSessionIds: [],
        reason: "agent_offline",
      },
    }),
    capture: captureAvailable(manifest(diffReview, treeReview, 4)),
    machines: fleet(
      machine({
        kind: "selfhosted",
        name: "dev-mbp",
        state: "offline",
        active: true,
        isSessionGroup: false,
      }),
    ),
    gitStatus: statusReview,
    gitDiff: diffReview,
    announceFileCount: 3,
  },
  // No changes yet — designed empty, not a placeholder. Default tab = Files.
  empty: {
    label: "Empty session",
    capabilities: caps("warm"),
    capture: captureNone,
    machines: fleet(machine({ state: "online" })),
    gitStatus: statusClean,
    gitDiff: [],
    tree: treeReview,
  },
  // Dense: 40-file diff + windowed rail. Capture-served.
  dense: {
    label: "Dense · 40-file diff",
    capabilities: capsCold(),
    capture: captureAvailable(manifest(diffDense(40), treeDense(30, 40), 12)),
    machines: fleet(machine({ state: "offline", active: false })),
    gitStatus: statusReview,
    gitDiff: diffDense(40),
    announceFileCount: 40,
  },
  // Per-file guard trips: binary + over-cap "open live".
  guard: {
    label: "Guard · open live",
    capabilities: caps("warm"),
    capture: captureNone,
    machines: fleet(machine({ state: "online" })),
    gitStatus: status([
      {
        path: "src/index.ts",
        oldPath: null,
        index: null,
        worktree: "modified",
        isConflicted: false,
      },
      {
        path: "assets/logo.png",
        oldPath: null,
        index: null,
        worktree: "modified",
        isConflicted: false,
      },
      {
        path: "data/fixtures.json",
        oldPath: null,
        index: null,
        worktree: "modified",
        isConflicted: false,
      },
    ]),
    gitDiff: diffGuard,
    tree: treeReview,
    announceFileCount: 3,
  },
  // Content stress: long host labels, path components, Unicode, and code lines.
  "content-stress": {
    label: "Content stress · Unicode and long labels",
    capabilities: caps("warm"),
    capture: captureNone,
    machines: fleet(
      machine({
        name: "Production observability and deployment coordination machine — Stockholm 01",
        state: "online",
      }),
    ),
    gitStatus: {
      ...status(
        diffContentStress.map((entry) => ({
          path: entry.path,
          oldPath: entry.oldPath,
          index: null,
          worktree: entry.status,
          isConflicted: false,
        })),
      ),
      head: "feature/internationalisation-observability-and-deployment-coordination",
      upstream: "origin/feature/internationalisation-observability-and-deployment-coordination",
    },
    gitDiff: diffContentStress,
    tree: treeContentStress,
    announceFileCount: 3,
  },
  // Capabilities negotiation failed AND no capture → honest degraded fallback.
  error: {
    label: "Error · sandbox unavailable",
    capabilities: "error",
    capture: captureNone,
    machines: { activeSandboxId: null, activeEpoch: 0, machines: [] },
    gitStatus: statusClean,
    gitDiff: [],
  },
  // Permission-limited: Git + FS only (no Terminal, no Desktop). Fewer tabs.
  "permission-gated": {
    label: "Permission-limited",
    capabilities: caps("warm", {
      Terminal: {
        transport: null,
        ptyCapable: false,
        shell: "/bin/bash",
        url: null,
        token: null,
        expiresAt: null,
        reason: "disabled_by_policy",
      },
      DesktopStream: {
        transport: null,
        client: null,
        mode: "read-only",
        url: null,
        token: null,
        expiresAt: null,
        resolution: [1024, 768],
        unredacted: false,
        requiresAcknowledgment: true,
        acknowledged: false,
        shared: false,
        sharedSessionIds: [],
        reason: "disabled_by_policy",
      },
    }),
    capture: captureNone,
    machines: fleet(machine({ state: "online" })),
    gitStatus: statusReview,
    gitDiff: diffReview,
    tree: treeReview,
    announceFileCount: 3,
  },
  // Cold + no capture + no changes yet → the honest "Connecting sandbox…" state.
  connecting: {
    label: "Connecting (cold, no capture)",
    capabilities: capsCold(),
    capture: captureNone,
    machines: fleet(machine({ state: "reconnecting", active: true })),
    gitStatus: statusClean,
    gitDiff: [],
  },
};

export type DockStateKey = keyof typeof DOCK_STATES;

/**
 * A mock client whose workspace-surface responses are chosen by a DockState. All
 * the session/event/timeline plumbing is inherited from MockOpenGeniClient; only
 * the ~7 methods the dock's hooks read are overridden.
 */
export class DockStateMockClient extends MockOpenGeniClient {
  private attachAttempts = 0;
  private recovered = false;

  constructor(private readonly state: DockState) {
    super();
    if (state.terminalHistory) {
      seedTerminalHistory(this.bus(DOCK_SESSION_ID));
      // Page reads with the server's filters, for this state only: the hooks
      // prefer `listEventPage` whenever a client has it.
      Object.assign(this, {
        listEventPage: async (
          _workspaceId: string,
          sessionId: string,
          options: SessionEventListOptions = {},
        ): Promise<SessionEventPage> => {
          const page = serverHistoryRead(this.bus(sessionId).events, options);
          recordHistoryRead(options, page.events);
          return page;
        },
      });
    }
    // Seed a capture announce so the pre-paint default tab resolves (Changes when
    // the session has changes, Files otherwise) exactly as production does.
    if (state.announceFileCount && state.announceFileCount > 0) {
      this.bus(DOCK_SESSION_ID).append("workspace.revision.captured", {
        revision: 1,
        turnId: "turn-1",
        capturedAt: CAPTURED_AT,
        leaseEpoch: 1,
        stats: {
          repoCount: 1,
          fileCount: state.announceFileCount,
          additions: 0,
          deletions: 0,
          totalBytes: 0,
          tooLargeCount: 0,
          binaryCount: 0,
          treeEntryCount: 24,
          treeTruncated: false,
          durationMs: 120,
          fingerprint: "fp-1",
        },
      });
    }
  }

  override async getStreamCapabilities(): Promise<SessionCapabilities> {
    if (this.state.capabilities === "error")
      throw new Error("sandbox unreachable — the box could not be resumed");
    return this.recovered
      ? caps("warm", { DesktopStream: capsCold().DesktopStream })
      : this.state.capabilities;
  }

  // A viewer attach warms the box; report the state's REAL liveness so a warm box
  // never gets folded back to "cold" (the base mock always says cold, which would
  // make the header chip lie about a live box once the Files tab warms it).
  override async attachViewer(): Promise<Awaited<ReturnType<MockOpenGeniClient["attachViewer"]>>> {
    if (this.state.liveFileWakeRecovery) {
      this.attachAttempts += 1;
      if (this.attachAttempts === 1) {
        throw new Error("Fixture attach failed: retry the live file");
      }
      this.recovered = true;
    }
    const base = await super.attachViewer();
    if (this.state.capabilities === "error") return { ...base, liveness: "cold" };
    // The holder and descriptor describe one exact lease. Regressing the mock
    // holder to the base fixture's epoch 0 makes a legitimate Files route fence
    // reset the editor after its first edit intent.
    return {
      ...base,
      liveness: this.recovered ? "warm" : this.state.capabilities.liveness,
      leaseEpoch: this.state.capabilities.leaseEpoch,
    };
  }

  override async getWorkspaceCapture(): Promise<GetWorkspaceCaptureResponse> {
    return this.state.capture;
  }

  override async listEvents(
    workspaceId: string,
    sessionId: string,
    options: SessionEventListOptions = {},
  ): Promise<SessionEvent[]> {
    if (!this.state.terminalHistory) return super.listEvents(workspaceId, sessionId, options);
    const page = serverHistoryRead(this.bus(sessionId).events, options);
    recordHistoryRead(options, page.events);
    return page.events;
  }

  override async listMachines(): Promise<MachinesResponse> {
    return this.state.machines;
  }

  override async fsRead(
    workspaceId: string,
    sessionId: string,
    request: { path: string },
  ): Promise<Awaited<ReturnType<MockOpenGeniClient["fsRead"]>>> {
    if (
      this.state.liveFileWakeRecovery &&
      request.path.replace(/^\/workspace\//, "") === "recovery.png"
    ) {
      if (!this.recovered) throw new Error("Live PNG read before successful attach");
      return {
        path: request.path,
        encoding: "base64",
        content: recoveryPng,
        sizeBytes: 187,
        truncated: false,
        isBinary: true,
        revision: 1,
      };
    }
    return super.fsRead(workspaceId, sessionId, request);
  }

  override async gitStatus(): Promise<GitStatusResponse> {
    return this.state.gitStatus;
  }

  override async gitDiff(
    _workspaceId: string,
    _sessionId: string,
    request?: { staged?: boolean },
  ): Promise<{ files: GitFileDiff[]; revision: number }> {
    if (request?.staged) return { files: [], revision: 1 };
    return { files: this.state.gitDiff, revision: 1 };
  }

  override async fsList(
    workspaceId: string,
    sessionId: string,
    request?: { path?: string },
  ): Promise<Awaited<ReturnType<MockOpenGeniClient["fsList"]>>> {
    const path = request?.path ?? "";
    const fixture = this.state.tree;
    if (!fixture) return super.fsList(workspaceId, sessionId, request);
    const fileSystemRoot =
      this.state.capabilities === "error" ? "" : this.state.capabilities.FileSystem.root;
    const rooted = path.startsWith("/") && fileSystemRoot.startsWith("/");
    const rootPath = rooted ? fileSystemRoot : "";
    const qualify = (node: FsTreeNode): FsTreeNode => ({
      ...node,
      path:
        node.path === ""
          ? rootPath
          : rootPath === "/"
            ? `/${node.path}`
            : rootPath
              ? `${rootPath}/${node.path}`
              : node.path,
      ...(node.children ? { children: node.children.map(qualify) } : {}),
    });
    const root = qualify(fixture);
    const shallow = (node: FsTreeNode): FsTreeNode => ({
      ...node,
      ...(node.children
        ? {
            children: node.children.map((child) =>
              child.type === "dir" ? { ...child, children: [] } : child,
            ),
          }
        : {}),
    });
    if (path === "" || path === rootPath) {
      return { root: shallow(root), revision: 1, truncated: false };
    }
    // Walk the fixture tree to the requested dir so lazy-expand serves children.
    const find = (node: FsTreeNode): FsTreeNode | null => {
      if (node.path === path) return node;
      for (const child of node.children ?? []) {
        const hit = find(child);
        if (hit) return hit;
      }
      return null;
    };
    const node = find(root);
    return {
      root: shallow(node ?? { ...root, path, name: path }),
      revision: 1,
      truncated: false,
    };
  }
}

// ── reloaded terminal history ────────────────────────────────────────────────

const ESC = "\u001b[";
const DIM = `${ESC}2m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;
const CYAN = `${ESC}36m`;
const YELLOW = `${ESC}33m`;
const RESET = `${ESC}0m`;
const PTY_ID = "7d1e2f30-4a5b-4c6d-8e7f-1a2b3c4d5e6f";
const PROMPT = `${GREEN}operator@api${RESET}:${CYAN}~/api${RESET}$ `;

type HistoryBus = {
  append: (type: string, payload: unknown, turnId?: string | null) => SessionEvent;
};

/**
 * A session as a reload finds it: an interactive terminal that tailed the API
 * log for a while (2,000 rows), then two finished turns whose commands ran in
 * the sandbox, with a short terminal check between them.
 */
function seedTerminalHistory(bus: HistoryBus): void {
  const pty = (chunk: string) =>
    bus.append("terminal.pty.output.delta", { ptyId: PTY_ID, stream: "stdout", chunk, seq: 0 });
  bus.append("terminal.pty.started", {
    ptyId: PTY_ID,
    cols: 120,
    rows: 32,
    shell: "/bin/bash",
    cwd: "/workspace/api",
  });
  pty(`${PROMPT}tail -f logs/api.log\r\n`);
  const routes = [
    "/v1/health",
    "/v1/orders",
    "/v1/orders/:id",
    "/v1/carts",
    "/v1/workspaces/:workspaceId/sessions",
  ];
  for (let index = 0; index < 2000; index += 1) {
    const seconds = String(index % 60).padStart(2, "0");
    const minutes = String(12 + (Math.floor(index / 60) % 48)).padStart(2, "0");
    const code = index % 97 === 0 ? `${YELLOW}429${RESET}` : `${GREEN}200${RESET}`;
    pty(
      `${DIM}2026-10-21T09:${minutes}:${seconds}Z${RESET} GET ${routes[index % routes.length]} ${code} ${12 + (index % 37)}ms\r\n`,
    );
  }
  pty("^C\r\n");

  const turn = (input: {
    turnId: string;
    question: string;
    command: string;
    output: string[];
    answer: string;
  }) => {
    bus.append("user.message", { text: input.question, routing: "accepted_for_execution" });
    bus.append("turn.started", { turnId: input.turnId }, input.turnId);
    const callId = `${input.turnId}-call`;
    bus.append(
      "agent.toolCall.created",
      { id: callId, name: "exec_command", arguments: { cmd: input.command } },
      input.turnId,
    );
    bus.append(
      "sandbox.command.output.delta",
      { stream: "stdout", chunk: `${PROMPT}${input.command}\r\n` },
      input.turnId,
    );
    for (const line of input.output) {
      bus.append("sandbox.command.output.delta", { stream: "stdout", chunk: line }, input.turnId);
    }
    bus.append("agent.toolCall.output", { id: callId, output: "ok" }, input.turnId);
    bus.append("agent.message.completed", { text: input.answer }, input.turnId);
    bus.append("turn.completed", { turnId: input.turnId }, input.turnId);
  };
  turn({
    turnId: "6a1b2c3d-0000-4000-8000-000000000001",
    question: "Run the API test suite and fix anything failing.",
    command: "bun test --filter api",
    output: [
      `${DIM}bun test v1.4.3${RESET}\r\n`,
      `${GREEN}✓${RESET} orders › creates an order ${DIM}[4.21ms]${RESET}\r\n`,
      `${GREEN}✓${RESET} orders › rejects an empty cart ${DIM}[1.02ms]${RESET}\r\n`,
      `${RED}×${RESET} carts › expires after 24h ${DIM}[0.88ms]${RESET}\r\n`,
      `${GREEN}✓${RESET} carts › expires after 24h (retry) ${DIM}[0.91ms]${RESET}\r\n`,
      `\r\n ${GREEN}412 pass${RESET}\r\n ${DIM}0 fail${RESET}\r\nRan 412 tests across 38 files. ${DIM}[2.84s]${RESET}\r\n`,
    ],
    answer: "Fixed the cart expiry clock skew; all 412 tests pass.",
  });
  pty(`${PROMPT}git status --short\r\n M src/carts/expiry.ts\r\n M test/carts.test.ts\r\n`);
  turn({
    turnId: "6a1b2c3d-0000-4000-8000-000000000002",
    question: "Deploy it to staging.",
    command: "kubectl rollout status deploy/api -n api-staging",
    output: [
      `Waiting for deployment "api" rollout to finish: 1 of 3 updated replicas are available...\r\n`,
      `Waiting for deployment "api" rollout to finish: 2 of 3 updated replicas are available...\r\n`,
      `deployment "api" successfully rolled out\r\n`,
      `${GREEN}Deploy reachable at https://api-staging.acme.dev${RESET}\r\n`,
    ],
    answer: "Staging is on the new build and healthy.",
  });
}

/** The API's history filters: types, presented calls, bounds, direction, limit. */
function serverHistoryRead(
  events: readonly SessionEvent[],
  options: SessionEventListOptions,
): SessionEventPage {
  const after = options.after ?? 0;
  const before = options.before ?? Number.MAX_SAFE_INTEGER;
  const include = options.includeTypes?.length ? new Set<string>(options.includeTypes) : null;
  const exclude = new Set<string>(options.excludeTypes ?? []);
  const rows = events.filter((event) => {
    if (event.sequence <= after || event.sequence >= before) return false;
    if (include && !include.has(event.type)) return false;
    if (!exclude.has(event.type)) return true;
    return (
      options.presentedToolCalls === "include" &&
      event.type === "agent.toolCall.created" &&
      isPresentedSessionToolName((event.payload as { name?: unknown } | null)?.name)
    );
  });
  const direction =
    options.direction ??
    (options.before !== undefined ? "before" : options.after !== undefined ? "after" : "before");
  const limit = options.limit ?? 500;
  const page = direction === "before" ? rows.slice(-limit) : rows.slice(0, limit);
  return {
    events: page,
    mode: "forensic",
    payloadMode: "full",
    direction,
    bytes: JSON.stringify(page).length,
    maxBytes: 1024 * 1024,
    truncated: rows.length > page.length,
    hasMore: rows.length > page.length,
    truncatedBy: rows.length > page.length ? "count" : null,
    coveredSequence:
      page.length > 0 ? { first: page[0]!.sequence, last: page.at(-1)!.sequence } : null,
    nextAfter: null,
    nextBefore: null,
    forensicExact: true,
  };
}

export type DockHistoryRead = {
  includeTypes: string[] | null;
  excludeTypes: string[] | null;
  rows: number;
  terminalRows: number;
};

declare global {
  // eslint-disable-next-line no-var
  var __OG_DOCK_HISTORY_READS__: DockHistoryRead[] | undefined;
}

/** Evidence for browser acceptance: every history read and what it returned. */
function recordHistoryRead(options: SessionEventListOptions, rows: readonly SessionEvent[]): void {
  const reads = (globalThis.__OG_DOCK_HISTORY_READS__ ??= []);
  reads.push({
    includeTypes: options.includeTypes ? [...options.includeTypes] : null,
    excludeTypes: options.excludeTypes ? [...options.excludeTypes] : null,
    rows: rows.length,
    terminalRows: rows.filter(
      (event) =>
        event.type === "terminal.pty.output.delta" || event.type === "sandbox.command.output.delta",
    ).length,
  });
}
