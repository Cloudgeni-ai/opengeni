import type {
  AttachViewerResponse,
  GitFileDiff,
  SessionCapabilities,
  SessionEvent,
} from "@opengeni/sdk";
import { SESSION_ID, WORKSPACE_ID } from "./fake-client";

/** A fully-warm, desktop-capable capability doc for a Modal-style box. */
export function fakeCapabilities(
  overrides: Partial<SessionCapabilities> = {},
): SessionCapabilities {
  return {
    sessionId: SESSION_ID,
    backend: "modal",
    os: "linux",
    liveness: "warm",
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
      transport: "sse-events",
      ptyCapable: false,
      shell: "/bin/bash",
      url: null,
      token: null,
      reason: null,
    },
    Git: { available: true, repos: ["."], reason: null },
    DesktopStream: {
      transport: "vnc-ws",
      client: "novnc",
      mode: "read-only",
      url: "https://box.modal.example/vnc.html?token=abc",
      token: "scoped-token",
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      resolution: [1024, 768],
      unredacted: true,
      requiresAcknowledgment: true,
      acknowledged: true,
      shared: false,
      sharedSessionIds: [],
      reason: null,
    },
    Recording: { available: true, modes: ["manual"], codecs: ["h264-mp4"], reason: null },
    ComputerUse: { available: true, readOnly: false, reason: null },
    negotiatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** A headless backend (Cloudflare/Vercel/none): structured surfaces only. */
export function fakeHeadlessCapabilities(): SessionCapabilities {
  return fakeCapabilities({
    backend: "cloudflare",
    DesktopStream: {
      transport: null,
      client: null,
      mode: "read-only",
      url: null,
      token: null,
      expiresAt: null,
      resolution: [1024, 768],
      unredacted: true,
      requiresAcknowledgment: false,
      acknowledged: false,
      shared: false,
      sharedSessionIds: [],
      reason: "backend_unsupported",
    },
    Recording: { available: false, modes: [], codecs: [], reason: "backend_unsupported" },
    ComputerUse: { available: false, readOnly: true, reason: "backend_unsupported" },
  });
}

/** A cold lease (no live box; between turns with no viewer). */
export function fakeColdCapabilities(): SessionCapabilities {
  return fakeCapabilities({
    liveness: "cold",
    leaseEpoch: 0,
    DesktopStream: {
      transport: null,
      client: null,
      mode: "read-only",
      url: null,
      token: null,
      expiresAt: null,
      resolution: [1024, 768],
      unredacted: true,
      requiresAcknowledgment: true,
      acknowledged: false,
      shared: false,
      sharedSessionIds: [],
      reason: "lease_cold",
    },
  });
}

export function fakeAttachResponse(
  overrides: Partial<AttachViewerResponse> = {},
): AttachViewerResponse {
  return {
    viewerId: "44444444-4444-4444-8444-444444444444",
    sandboxGroupId: "55555555-5555-4555-8555-555555555555",
    liveness: "warm",
    leaseEpoch: 1,
    viewerHeartbeatIntervalMs: 30_000,
    dataPlaneUrl: "https://box.modal.example/vnc.html",
    streamToken: "holder-token",
    streamExpiresAt: new Date(Date.now() + 600_000).toISOString(),
    resolution: [1024, 768],
    transport: "vnc-ws",
    client: "novnc",
    terminalUrl: null,
    terminalToken: null,
    terminalTransport: null,
    ...overrides,
  };
}

export function fakeEvent(sequence: number, type: string, payload: unknown = {}): SessionEvent {
  return {
    id: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    workspaceId: WORKSPACE_ID,
    sessionId: SESSION_ID,
    sequence,
    type,
    payload,
    occurredAt: new Date().toISOString(),
  };
}

export function fakeFileDiff(overrides: Partial<GitFileDiff> = {}): GitFileDiff {
  return {
    path: "src/app.ts",
    oldPath: null,
    status: "modified",
    isBinary: false,
    isImage: false,
    additions: 2,
    deletions: 1,
    truncated: false,
    hunks: [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 3,
        header: "@@ -1,2 +1,3 @@",
        lines: [
          { type: "context", oldNo: 1, newNo: 1, text: "const a = 1;" },
          { type: "del", oldNo: 2, newNo: null, text: "const b = 2;" },
          { type: "add", oldNo: null, newNo: 2, text: "const b = 3;" },
          { type: "add", oldNo: null, newNo: 3, text: "const c = 4;" },
        ],
      },
    ],
    ...overrides,
  };
}
