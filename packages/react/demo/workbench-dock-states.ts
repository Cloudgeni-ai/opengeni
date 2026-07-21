/* ----------------------------------------------------------------------------
   M7 full-dock state matrix — fixtures + a state-driven mock client.

   The M5/M6 harnesses render sub-components (WorkbenchChanges, FileBrowser,
   SandboxTerminal) in isolation. M7 reviews the WHOLE dock — frame + header +
   machine chip + tab strip + every surface — in each state of the dossier §13
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
  WorkspaceCaptureManifest,
} from "@opengeni/sdk";
import type { MachinesResponse, MachineView } from "../src/machines";
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
    active: true,
    isSessionGroup: true,
    os: "linux",
    arch: "x86_64",
    hasDisplay: true,
    allowScreenControl: false,
    sharedSessionCount: 1,
    lastSeenAt: new Date().toISOString(),
    metrics: null,
    ...overrides,
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
};

export const DOCK_STATES: Record<string, DockState> = {
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
  constructor(private readonly state: DockState) {
    super();
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
    return this.state.capabilities;
  }

  // A viewer attach warms the box; report the state's REAL liveness so a warm box
  // never gets folded back to "cold" (the base mock always says cold, which would
  // make the header chip lie about a live box once the Files tab warms it).
  override async attachViewer(): Promise<Awaited<ReturnType<MockOpenGeniClient["attachViewer"]>>> {
    const base = await super.attachViewer();
    const liveness =
      this.state.capabilities === "error" ? "cold" : this.state.capabilities.liveness;
    return { ...base, liveness };
  }

  override async getWorkspaceCapture(): Promise<GetWorkspaceCaptureResponse> {
    return this.state.capture;
  }

  override async listMachines(): Promise<MachinesResponse> {
    return this.state.machines;
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
    const root = this.state.tree;
    if (!root) return super.fsList(workspaceId, sessionId, request);
    const path = request?.path ?? "";
    if (path === "") return { root, revision: 1, truncated: false };
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
    return { root: node ?? { ...root, path, name: path }, revision: 1, truncated: false };
  }
}
