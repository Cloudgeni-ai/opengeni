import { describe, expect, test } from "bun:test";
import type { RetainedArtifactReference } from "@opengeni/sdk";
import { act } from "react";
import { flush, registerDom, renderComponent } from "./render-hook";
import {
  PatchApplyCommand,
  applyCommandLifetime,
  isPatchFilename,
  patchApplyCommand,
} from "../src/timeline/patch-apply-command";

registerDom();

const artifact: RetainedArtifactReference = {
  available: true,
  artifactId: "33333333-3333-4333-8333-333333333333",
  kind: "file",
  contentType: "application/octet-stream",
  originalBytes: 120,
  sha256: "c".repeat(64),
  retainedAt: "2026-10-05T00:00:00.000Z",
  retention: { policy: "workspace_file", expiresAt: null },
  retrieval: {
    method: "GET",
    path: "/v1/workspaces/workspace-a/artifacts/33333333-3333-4333-8333-333333333333/content",
    acceptRanges: "bytes",
    maxRangeBytes: 1024 * 1024,
  },
};

function clickApply(container: HTMLElement) {
  const button = [...container.querySelectorAll("button")].find((candidate) =>
    candidate.textContent?.includes("Copy command to apply these changes"),
  );
  expect(button).toBeDefined();
  return act(async () => button!.click());
}

describe("patch apply command", () => {
  test("recognizes patch files and single-quotes the signed URL for the shell", () => {
    expect(isPatchFilename("changes.patch")).toBe(true);
    expect(isPatchFilename("fix.DIFF")).toBe(true);
    expect(isPatchFilename("notes.txt")).toBe(false);
    expect(isPatchFilename("patch.zip")).toBe(false);
    expect(patchApplyCommand("https://objects.example/p?a=1&b='x'")).toBe(
      "curl -fsSL 'https://objects.example/p?a=1&b='\\''x'\\''' | git apply",
    );
  });

  test("names the link lifetime from the signed URL expiry", () => {
    const now = Date.parse("2026-10-05T12:00:00.000Z");
    expect(applyCommandLifetime("2026-10-05T12:05:00.000Z", now)).toBe("5 minutes");
    expect(applyCommandLifetime("2026-10-05T12:00:30.000Z", now)).toBe("1 minute");
    expect(applyCommandLifetime(undefined, now)).toBe("5 minutes");
  });

  test("shows the command for manual copy when the clipboard refuses", async () => {
    const clipboard = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    const clipboardItem = (globalThis as { ClipboardItem?: unknown }).ClipboardItem;
    (globalThis as { ClipboardItem?: unknown }).ClipboardItem = undefined;
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: async () => {
          throw new Error("denied");
        },
      },
    });
    const execCommand = document.execCommand;
    document.execCommand = () => false;
    const r = await renderComponent(
      <PatchApplyCommand
        artifact={artifact}
        filename="changes.patch"
        load={async () => ({
          url: "https://objects.example/changes.patch?sig=1",
          expiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
        })}
      />,
    );
    try {
      await clickApply(r.container);
      await flush();
      const field = r.container.querySelector("input");
      expect(field?.value).toBe(
        "curl -fsSL 'https://objects.example/changes.patch?sig=1' | git apply",
      );
      expect(r.container.textContent).toContain("The link in it expires in 5 minutes.");
    } finally {
      await r.unmount();
      document.execCommand = execCommand;
      (globalThis as { ClipboardItem?: unknown }).ClipboardItem = clipboardItem;
      if (clipboard) Object.defineProperty(navigator, "clipboard", clipboard);
      else delete (navigator as { clipboard?: unknown }).clipboard;
    }
  });

  test("falls back to plain download instructions when a host loader returns bytes", async () => {
    const r = await renderComponent(
      <PatchApplyCommand
        artifact={artifact}
        filename="changes.patch"
        load={async () => new Uint8Array([1, 2, 3])}
      />,
    );
    try {
      await clickApply(r.container);
      await flush();
      expect(r.container.textContent).toContain(
        "Download changes.patch, then run git apply changes.patch in your project folder.",
      );
      expect(r.container.querySelector("input")).toBeNull();
    } finally {
      await r.unmount();
    }
  });
});
