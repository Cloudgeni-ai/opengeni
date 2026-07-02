import { describe, expect, test } from "bun:test";
import {
  CAPABILITY_DESCRIPTORS,
  DESKTOP_STREAM_PORT,
  SandboxBackend,
  type SandboxBackend as SandboxBackendType,
} from "@opengeni/contracts";
import { testSettings } from "@opengeni/testing";
import {
  PROVIDER_REGISTRY,
  SandboxConfigError,
  assertDescriptorRegistryInvariants,
  assertProviderRegistryInvariants,
  createSandboxClient,
  negotiateCapabilities,
  selectBackend,
} from "../src/sandbox";

// Per-provider credential stubs so build() can run without real creds. Only the
// fields validateCredentials requires per backend are present.
const CREDS: Record<SandboxBackendType, Record<string, unknown>> = {
  docker: {},
  local: {},
  none: {},
  modal: { modalTokenId: "id", modalTokenSecret: "secret" },
  daytona: { daytonaApiKey: "k" },
  runloop: { runloopApiKey: "k" },
  e2b: { e2bApiKey: "k" },
  blaxel: { blaxelApiKey: "k" },
  cloudflare: { cloudflareWorkerUrl: "https://w.example.com" },
  vercel: { vercelToken: "t", vercelProjectId: "p" },
  // selfhosted needs no per-box creds (the user's own machine over the agent's
  // enrollment) — validateCredentials is a no-op.
  selfhosted: {},
};

describe("provider registry — descriptor invariants + backendId assertion", () => {
  test("descriptor table self-test passes", () => {
    expect(() => assertDescriptorRegistryInvariants()).not.toThrow();
  });

  test("every registered provider's SDK client.backendId === descriptor.backendId", () => {
    // The deferred-from-P0.1 assertion: it constructs the real SDK clients.
    expect(() => assertProviderRegistryInvariants()).not.toThrow();
  });

  test("registry covers exactly the 11 backends, each self-consistent", () => {
    expect(Object.keys(PROVIDER_REGISTRY).sort()).toEqual([...SandboxBackend.options].sort());
    for (const backend of SandboxBackend.options) {
      const reg = PROVIDER_REGISTRY[backend];
      expect(reg.backend).toBe(backend);
      expect(reg.descriptor.backend).toBe(backend);
      // backendId == enum key for all but local (SDK reports "unix_local").
      expect(reg.descriptor.backendId).toBe(backend === "local" ? "unix_local" : backend);
    }
  });
});

describe("createSandboxClient — per-backend matrix construction", () => {
  for (const backend of SandboxBackend.options) {
    test(`constructs ${backend}`, () => {
      const settings = testSettings({ sandboxBackend: backend, ...CREDS[backend] });
      const client = createSandboxClient(settings);
      if (backend === "none") {
        expect(client).toBeUndefined();
        return;
      }
      expect(client).toBeDefined();
      // The SDK client reports the descriptor's backendId (== the enum key for
      // every backend except local, whose SDK client.backendId is "unix_local").
      expect((client as { backendId?: unknown }).backendId).toBe(CAPABILITY_DESCRIPTORS[backend].backendId);
    });
  }

  test("modal builds with real-ish stub creds and threads tokens", () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalTokenId: "tok-id",
      modalTokenSecret: "tok-secret",
      modalAppName: "my-app",
    });
    const client = createSandboxClient(settings) as { backendId: string; options?: Record<string, unknown> };
    expect(client.backendId).toBe("modal");
    expect(client.options?.appName).toBe("my-app");
    expect(client.options?.tokenId).toBe("tok-id");
    expect(client.options?.tokenSecret).toBe("tok-secret");
    // modalTimeoutSeconds default (3600s) → ms.
    expect(client.options?.timeoutMs).toBe(3_600_000);
    // Bounded create waits come from OPENGENI_SANDBOX_WARMING_TIMEOUT_MS.
    expect(client.options?.sandboxCreateTimeoutS).toBe(600);
    // The Agents extension otherwise stamps a hardcoded sleep command; let
    // Modal's own timeout own lifetime instead.
    expect(client.options?.useSleepCmd).toBe(false);
    // sandbox-file-persistence: idleTimeoutMs is ALWAYS pinned; with no explicit
    // OPENGENI_MODAL_IDLE_TIMEOUT_SECONDS it DEFAULTS to the hard lifetime so
    // Modal's short server-default idle-reap can never kill an idle box before the
    // OpenGeni reaper snapshots /workspace.
    expect(client.options?.idleTimeoutMs).toBe(3_600_000);
  });

  test("modal hard lifetime and create timeout derive from configured settings", () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalTokenId: "tok-id",
      modalTokenSecret: "tok-secret",
      modalAppName: "my-app",
      modalTimeoutSeconds: 7200,
      sandboxWarmingTimeoutMs: 123_000,
    });
    const client = createSandboxClient(settings) as { options?: Record<string, unknown> };
    expect(client.options?.timeoutMs).toBe(7_200_000);
    expect(client.options?.idleTimeoutMs).toBe(7_200_000);
    expect(client.options?.sandboxCreateTimeoutS).toBe(123);
    expect(client.options?.useSleepCmd).toBe(false);
  });

  test("modal idleTimeoutMs honours an explicit override (still pinned, not the SDK default)", () => {
    const settings = testSettings({
      sandboxBackend: "modal",
      modalTokenId: "tok-id",
      modalTokenSecret: "tok-secret",
      modalAppName: "my-app",
      modalIdleTimeoutSeconds: 1200,
    });
    const client = createSandboxClient(settings) as { options?: Record<string, unknown> };
    expect(client.options?.idleTimeoutMs).toBe(1_200_000);
  });

  test("modal both-or-neither token validation fails fast (typed error)", () => {
    const settings = testSettings({ sandboxBackend: "modal", modalTokenId: "only-id" });
    expect(() => createSandboxClient(settings)).toThrow(SandboxConfigError);
  });

  test("each credentialed backend fails fast without its required creds", () => {
    for (const backend of ["daytona", "runloop", "e2b", "blaxel", "cloudflare", "vercel"] as const) {
      const settings = testSettings({ sandboxBackend: backend });
      expect(() => createSandboxClient(settings)).toThrow(SandboxConfigError);
    }
  });

  test("provider option units differ — not a Modal mirror", () => {
    // runloop keep-alive lives under timeouts.keepAliveTimeoutMs (ms), NOT a
    // top-level idleTimeoutMs like modal.
    const runloop = createSandboxClient(
      testSettings({ sandboxBackend: "runloop", runloopApiKey: "k", runloopKeepAliveSeconds: 60 }),
    ) as { options?: { timeouts?: { keepAliveTimeoutMs?: number } } };
    expect(runloop.options?.timeouts?.keepAliveTimeoutMs).toBe(60_000);

    // e2b `timeout` is in SECONDS (SDK ×1000 internally), not ms.
    const e2b = createSandboxClient(
      testSettings({ sandboxBackend: "e2b", e2bApiKey: "k", e2bTimeoutSeconds: 120 }),
    ) as { options?: { timeout?: number } };
    expect(e2b.options?.timeout).toBe(120);
  });
});

describe("createSandboxClient — 6080 desktop-port merge", () => {
  // Pre-declare backends: desktop-capable + NOT on-demand → 6080 must be merged.
  const PREDECLARE = ["modal", "runloop", "e2b"] as const;
  for (const backend of PREDECLARE) {
    test(`merges 6080 for ${backend} when desktop enabled`, () => {
      const client = createSandboxClient(
        testSettings({ sandboxBackend: backend, ...CREDS[backend], sandboxDesktopEnabled: true }),
      ) as { options?: { exposedPorts?: number[] } };
      expect(client.options?.exposedPorts).toContain(DESKTOP_STREAM_PORT);
    });

    test(`does NOT merge 6080 for ${backend} when desktop disabled`, () => {
      const client = createSandboxClient(
        testSettings({ sandboxBackend: backend, ...CREDS[backend], sandboxDesktopEnabled: false }),
      ) as { options?: { exposedPorts?: number[] } };
      expect(client.options?.exposedPorts ?? []).not.toContain(DESKTOP_STREAM_PORT);
    });
  }

  test("blaxel is on-demand → no pre-declared 6080 even with desktop enabled", () => {
    // blaxel options carry no exposedPorts list at all (resolved on demand).
    const client = createSandboxClient(
      testSettings({ sandboxBackend: "blaxel", blaxelApiKey: "k", sandboxDesktopEnabled: true }),
    ) as { options?: { exposedPorts?: number[] } };
    expect(client.options?.exposedPorts).toBeUndefined();
  });

  test("headless backends (cloudflare/vercel) never get 6080 — not desktop-capable", () => {
    for (const backend of ["cloudflare", "vercel"] as const) {
      const client = createSandboxClient(
        testSettings({ sandboxBackend: backend, ...CREDS[backend], sandboxDesktopEnabled: true }),
      ) as { options?: { exposedPorts?: number[] } };
      expect(client.options?.exposedPorts ?? []).not.toContain(DESKTOP_STREAM_PORT);
    }
  });
});

describe("negotiateCapabilities — coherent doc, degrades as a value", () => {
  const base = {
    sessionId: "00000000-0000-0000-0000-000000000001",
    os: "linux" as const,
    liveness: "warm" as const,
    leaseEpoch: 3,
    desktopEnabled: true,
    now: new Date("2026-06-20T00:00:00.000Z"),
  };

  test("every (backend) yields a fully-populated SessionCapabilities (no absent cells)", () => {
    for (const backend of SandboxBackend.options) {
      const caps = negotiateCapabilities({ ...base, backend });
      // Each capability block exists and carries availability + reason fields.
      expect(caps.FileSystem).toBeDefined();
      expect(caps.Terminal).toBeDefined();
      expect(caps.Git).toBeDefined();
      expect(caps.DesktopStream).toBeDefined();
      expect(caps.Recording).toBeDefined();
      // reason is null-or-string, never undefined/absent.
      expect(caps.FileSystem.reason === null || typeof caps.FileSystem.reason === "string").toBe(true);
      expect(caps.DesktopStream.reason === null || typeof caps.DesktopStream.reason === "string").toBe(true);
      expect(caps.leaseEpoch).toBe(3);
    }
  });

  test("modal warm+desktop: desktop available with vnc-ws + ack required", () => {
    const caps = negotiateCapabilities({ ...base, backend: "modal" });
    expect(caps.DesktopStream.transport).toBe("vnc-ws");
    expect(caps.DesktopStream.client).toBe("novnc");
    expect(caps.DesktopStream.reason).toBeNull();
    expect(caps.DesktopStream.unredacted).toBe(true);
    expect(caps.DesktopStream.requiresAcknowledgment).toBe(true);
    expect(caps.Recording.available).toBe(true);
    expect(caps.Terminal.transport).toBe("pty-ws"); // modal has real pty
  });

  test("headless backend → desktop unavailable with tier_headless reason", () => {
    const caps = negotiateCapabilities({ ...base, backend: "vercel" });
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("tier_headless");
    expect(caps.Recording.available).toBe(false);
    expect(caps.Recording.reason).toBe("tier_headless");
    // But FS/Terminal/Git stay available on headless.
    expect(caps.FileSystem.available).toBe(true);
    expect(caps.Terminal.transport).toBe("sse-events"); // vercel: no pty
  });

  test("desktop disabled by policy → reason disabled_by_policy on a desktop backend", () => {
    const caps = negotiateCapabilities({ ...base, backend: "modal", desktopEnabled: false });
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("disabled_by_policy");
    expect(caps.Recording.reason).toBe("disabled_by_policy");
  });

  test("cold lease → desktop reason lease_cold on a desktop backend", () => {
    const caps = negotiateCapabilities({ ...base, backend: "modal", liveness: "cold" });
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("lease_cold");
  });

  // ── A successfully-minted relay/Modal stream url is ITSELF proof of liveness ──
  // A selfhosted-active session has NO warm Modal GROUP lease, so ctx.liveness is
  // "cold" — but the stream cells are minted against the selfhosted RELAY (the box
  // actually served the port). A present minted url must therefore be HONOURED;
  // lease_cold only fires when nothing was minted.
  test("cold lease + minted terminalStream (selfhosted relay pty-ws) → honoured, NOT lease_cold", () => {
    const minted = {
      url: "wss://relay.preview.app.opengeni.ai/stream?ws=W&agent=A&port=7681&channel=C",
      token: "ogs_terminaltoken",
      expiresAt: "2026-06-20T01:00:00.000Z",
    };
    const caps = negotiateCapabilities({
      ...base,
      backend: "modal",
      liveness: "cold",
      terminalStream: minted,
    });
    expect(caps.Terminal.transport).toBe("pty-ws");
    expect(caps.Terminal.url).toBe(minted.url);
    expect(caps.Terminal.token).toBe(minted.token);
    expect(caps.Terminal.expiresAt).toBe(minted.expiresAt);
    expect(caps.Terminal.reason).toBeNull();
  });

  test("cold lease + minted+acked desktopStream (selfhosted relay framebuffer) → honoured, NOT lease_cold", () => {
    const minted = {
      url: "wss://relay.preview.app.opengeni.ai/stream?ws=W&agent=A&port=6080&channel=C",
      token: "ogs_desktoptoken",
      expiresAt: "2026-06-20T01:00:00.000Z",
      resolution: [1280, 800] as [number, number],
    };
    const caps = negotiateCapabilities({
      ...base,
      backend: "modal",
      liveness: "cold",
      desktopEnabled: true,
      streamTokenSecretAvailable: true,
      desktopAcknowledged: true,
      desktopStream: minted,
    });
    expect(caps.DesktopStream.transport).not.toBeNull();
    expect(caps.DesktopStream.reason).toBeNull();
    expect(caps.DesktopStream.url).toBe(minted.url);
    expect(caps.DesktopStream.token).toBe(minted.token);
    expect(caps.DesktopStream.resolution).toEqual(minted.resolution);
  });

  test("REGRESSION: cold lease + NO minted stream → still lease_cold (terminal degrades to sse-events)", () => {
    const caps = negotiateCapabilities({ ...base, backend: "modal", liveness: "cold" });
    // Desktop (regression of the unchanged path above).
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.DesktopStream.reason).toBe("lease_cold");
    expect(caps.DesktopStream.url).toBeNull();
    // Terminal also degrades to the read-only firehose when nothing was minted.
    expect(caps.Terminal.transport).toBe("sse-events");
    expect(caps.Terminal.reason).toBe("lease_cold");
    expect(caps.Terminal.url).toBeNull();
  });

  // The ack gate is NOT weakened by honouring a cold-but-minted desktop: a minted
  // url with NO acknowledgment is still withheld (the un-redacted-pixel consent
  // gate). The cell stays available (liveness honoured) but the live url is dropped.
  test("cold lease + minted desktopStream but NOT acknowledged → ack gate still drops the url", () => {
    const minted = {
      url: "wss://relay.preview.app.opengeni.ai/stream?ws=W&agent=A&port=6080&channel=C",
      token: "ogs_desktoptoken",
      expiresAt: "2026-06-20T01:00:00.000Z",
      resolution: [1280, 800] as [number, number],
    };
    const caps = negotiateCapabilities({
      ...base,
      backend: "modal",
      liveness: "cold",
      desktopEnabled: true,
      streamTokenSecretAvailable: true,
      desktopAcknowledged: false,
      desktopStream: minted,
    });
    expect(caps.DesktopStream.transport).not.toBeNull();
    expect(caps.DesktopStream.reason).toBeNull();
    expect(caps.DesktopStream.url).toBeNull();
    expect(caps.DesktopStream.acknowledged).toBe(false);
  });

  test("unsupported OS knocks out every capability with os_unsupported", () => {
    const caps = negotiateCapabilities({ ...base, backend: "modal", os: "windows" });
    expect(caps.FileSystem.available).toBe(false);
    expect(caps.FileSystem.reason).toBe("os_unsupported");
    expect(caps.Terminal.reason).toBe("os_unsupported");
    expect(caps.Git.reason).toBe("os_unsupported");
    expect(caps.DesktopStream.reason).toBe("os_unsupported");
    expect(caps.Recording.reason).toBe("os_unsupported");
  });

  test("none backend → all capabilities unavailable, document still complete", () => {
    const caps = negotiateCapabilities({ ...base, backend: "none" });
    expect(caps.FileSystem.available).toBe(false);
    expect(caps.Terminal.transport).toBeNull();
    expect(caps.Git.available).toBe(false);
    expect(caps.DesktopStream.transport).toBeNull();
    expect(caps.Recording.available).toBe(false);
  });

  test("FileSystem.root matches the descriptor workspaceRoot", () => {
    expect(negotiateCapabilities({ ...base, backend: "e2b" }).FileSystem.root).toBe("/home/user");
    expect(negotiateCapabilities({ ...base, backend: "vercel" }).FileSystem.root).toBe("/vercel/sandbox");
  });

  test("selectBackend returns the descriptor for the backend", () => {
    expect(selectBackend("modal")).toBe(CAPABILITY_DESCRIPTORS.modal);
  });
});
