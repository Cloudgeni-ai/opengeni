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
};

describe("provider registry — descriptor invariants + backendId assertion", () => {
  test("descriptor table self-test passes", () => {
    expect(() => assertDescriptorRegistryInvariants()).not.toThrow();
  });

  test("every registered provider's SDK client.backendId === descriptor.backendId", () => {
    // The deferred-from-P0.1 assertion: it constructs the real SDK clients.
    expect(() => assertProviderRegistryInvariants()).not.toThrow();
  });

  test("registry covers exactly the 10 backends, each self-consistent", () => {
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
    // 900s default → ms.
    expect(client.options?.timeoutMs).toBe(900_000);
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
