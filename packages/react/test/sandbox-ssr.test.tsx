/* ----------------------------------------------------------------------------
   SSR safety: the xterm + noVNC components must render to a string on the server
   (no DOM, no window) WITHOUT crashing. This file deliberately does NOT register
   happy-dom — it runs against the bare server runtime, asserting the lazy
   imports are gated behind useEffect (client-only) and the placeholder paints.

   It also pins the pure desktop reducer/url logic from @opengeni/sdk, which the
   components delegate their state transitions to.
   -------------------------------------------------------------------------- */
import { describe, expect, test } from "bun:test";
import { renderToString } from "react-dom/server";
import {
  applyUrlRotation,
  desktopSocketUrl,
  nextDesktopState,
  type DesktopConnectionState,
  type StreamUrlRotatedPayload,
} from "@opengeni/sdk";
import { DesktopViewer } from "../src/components/desktop-viewer";
import { SandboxTerminal } from "../src/components/sandbox-terminal";
import { WorkspaceDock } from "../src/components/workspace-dock";

describe("SSR safety (no DOM / no window)", () => {
  test("SandboxTerminal renders to a string on the server (placeholder, no xterm import)", () => {
    const html = renderToString(
      <SandboxTerminal
        result={{
          chunks: [],
          running: false,
          write: null,
          activePtyId: null,
          close: () => {},
          error: null,
        }}
        placeholder="loading"
      />,
    );
    // The placeholder is present; xterm is NOT imported during the server render
    // (the import lives inside useEffect, which does not run during SSR).
    expect(html).toContain("loading");
  });

  test("DesktopViewer renders to a string on the server (no RFB import, no crash)", () => {
    const cap = {
      transport: "vnc-ws" as const,
      client: "novnc" as const,
      mode: "read-only" as const,
      url: "https://box.example/vnc.html",
      token: "t",
      expiresAt: null,
      resolution: [1024, 768] as [number, number],
      unredacted: true,
      requiresAcknowledgment: false,
      acknowledged: true,
      shared: false,
      sharedSessionIds: [],
      reason: null,
    };
    const html = renderToString(<DesktopViewer capability={cap} />);
    expect(html).toContain("data-opengeni-desktop");
  });

  test("WorkspaceDock renders without an ambient localStorage during SSR", () => {
    expect(typeof window).toBe("undefined");
    expect(typeof localStorage).toBe("undefined");

    const html = renderToString(
      <WorkspaceDock
        primary={<main>Server-rendered primary pane</main>}
        tabs={[{ id: "files", label: "Files", content: <div>Captured files</div> }]}
        collapsed
      />,
    );

    expect(html).toContain("Server-rendered primary pane");
  });
});

describe("desktop transport reducers (pure, @opengeni/sdk)", () => {
  test("nextDesktopState walks the lifecycle and fences ended", () => {
    expect(nextDesktopState("idle", { type: "negotiated" })).toBe("connecting");
    expect(nextDesktopState("connecting", { type: "connected" })).toBe("connected");
    expect(nextDesktopState("connected", { type: "rotate" })).toBe("rotating");
    expect(nextDesktopState("connected", { type: "disconnected" })).toBe("reconnecting");
    expect(nextDesktopState("ended" as DesktopConnectionState, { type: "disconnected" })).toBe(
      "ended",
    );
    expect(nextDesktopState("connected", { type: "fail" })).toBe("error");
    expect(nextDesktopState("connected", { type: "abort" })).toBe("ended");
  });

  test("applyUrlRotation drops a stale-epoch rotation, applies a fresh one", () => {
    const cap = { url: "https://old.example/vnc.html", token: "old", expiresAt: null };
    const stale: StreamUrlRotatedPayload = {
      url: "https://stale.example",
      token: "x",
      expiresAt: null,
      leaseEpoch: 1,
      transport: "vnc-ws",
      viewerId: null,
    };
    const fresh: StreamUrlRotatedPayload = {
      url: "https://new.example",
      token: "y",
      expiresAt: "2026-01-01T00:00:00Z",
      leaseEpoch: 3,
      transport: "vnc-ws",
      viewerId: null,
    };
    expect(applyUrlRotation(cap, stale, 2)).toBeNull();
    const applied = applyUrlRotation(cap, fresh, 2);
    expect(applied?.url).toBe("https://new.example");
    expect(applied?.token).toBe("y");
  });

  test("desktopSocketUrl normalizes vnc.html → wss websockify, no double-token", () => {
    expect(desktopSocketUrl({ url: "https://box.example/vnc.html?token=abc" })).toBe(
      "wss://box.example/websockify",
    );
    // A bare host/socket path is upgraded to wss and left otherwise intact.
    expect(desktopSocketUrl({ url: "https://box.example/proxy/6080?bl_preview_token=xyz" })).toBe(
      "wss://box.example/proxy/6080?bl_preview_token=xyz",
    );
  });
});
