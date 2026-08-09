import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import type { AccessContext, WorkspaceCaptureManifest } from "@opengeni/sdk";

import {
  createTerminalOutputProbe,
  axeManualContrastSelector,
  assertFixtureCapture,
  assertFixtureToolOutput,
  assertDedicatedCanaryEmail,
  assertAcceptancePrincipalScopes,
  assertChangedFileLabelsContainRepositoryRoots,
  assertChangesDefaultVisible,
  assertRepositoryChangesVisible,
  captureApiRegionalProbeEnvironment,
  controlCancellationDurationMs,
  fixturePrompt,
  isExpectedBrowserCancellation,
  maskKnownPublicEvidenceValues,
  openWorkspaceIfCollapsed,
  parseCookieHeader,
  parseLiveAcceptanceArgs,
  parseProtectedEmails,
  runCaptureApiRegionalProbe,
  selectTreeFile,
  terminalOutputCommand,
  validateCaptureApiRegionalProbeResult,
  waitForCold,
  waitForInteractiveTerminal,
  waitForSandboxLiveness,
  waitForSandboxFileViewerText,
  waitForWarm,
  type CaptureApiRegionalProbeRequest,
} from "./workbench-live-acceptance";

describe("workbench live acceptance preflight", () => {
  test("observes split binary terminal output without depending on xterm DOM rows", async () => {
    let onSocket: ((socket: unknown) => void) | undefined;
    let onFrame: ((frame: { payload: string | Buffer }) => void) | undefined;
    const page = {
      on: (event: string, listener: (socket: unknown) => void) => {
        expect(event).toBe("websocket");
        onSocket = listener;
      },
    } as never;
    const socket = {
      on: (event: string, listener: (frame: { payload: string | Buffer }) => void) => {
        expect(event).toBe("framereceived");
        onFrame = listener;
      },
    };
    const probe = createTerminalOutputProbe(page);
    onSocket?.(socket);

    await probe.expect("TERMINAL_EXACT_MARKER", async () => {
      onFrame?.({ payload: "noise TERMINAL_EX" });
      onFrame?.({ payload: Buffer.from("ACT_MARKER") });
    });
  });

  test("clears a failed terminal action before the next observation", async () => {
    let onSocket: ((socket: unknown) => void) | undefined;
    let onFrame: ((frame: { payload: string | Buffer }) => void) | undefined;
    const probe = createTerminalOutputProbe({
      on: (_event: string, listener: (socket: unknown) => void) => {
        onSocket = listener;
      },
    } as never);
    onSocket?.({
      on: (_event: string, listener: (frame: { payload: string | Buffer }) => void) => {
        onFrame = listener;
      },
    });

    await expect(
      probe.expect("FAILED_ACTION", async () => {
        throw new Error("keyboard unavailable");
      }),
    ).rejects.toThrow("keyboard unavailable");
    await probe.expect("RECOVERED_ACTION", async () => {
      onFrame?.({ payload: "RECOVERED_ACTION" });
    });
  });

  test("terminal acceptance command proves execution rather than matching echoed input", () => {
    const marker = "TERMINAL_EXACT_MARKER";
    const command = terminalOutputCommand(marker);
    expect(command).not.toContain(marker);
    const encoded = command.match(/'([A-Za-z0-9+/=]+)'/)?.[1];
    expect(encoded).toBeDefined();
    expect(Buffer.from(encoded!, "base64").toString("utf8")).toBe(`${marker}\n`);
  });

  test("waits for terminal interactivity before resolving the xterm input", async () => {
    const calls: unknown[] = [];
    const input = {
      waitFor: async (options: { state: string; timeout: number }) => {
        calls.push(["input.waitFor", options]);
      },
    };
    const interactiveTerminal = {
      waitFor: async (options: { state: string; timeout: number }) => {
        calls.push(["interactive.waitFor", options]);
      },
      locator: (selector: string) => {
        calls.push(["interactive.locator", selector]);
        return input;
      },
    };
    const terminal = {
      waitFor: async (options: { state: string; timeout: number }) => {
        calls.push(["terminal.waitFor", options]);
      },
      click: async () => {
        calls.push(["terminal.click"]);
      },
    };
    const page = {
      locator: (selector: string) => {
        calls.push(["page.locator", selector]);
        return selector === "[data-opengeni-terminal]" ? terminal : interactiveTerminal;
      },
    } as never;

    const resolved = await waitForInteractiveTerminal(page, 90_000);

    expect(resolved).toBe(input as never);
    expect(calls).toEqual([
      ["page.locator", "[data-opengeni-terminal]"],
      ["terminal.waitFor", { state: "visible", timeout: 90_000 }],
      ["terminal.click"],
      [
        "page.locator",
        '[data-opengeni-terminal][data-opengeni-terminal-status="open"]' +
          '[data-opengeni-terminal-interactive="true"]',
      ],
      ["interactive.waitFor", { state: "visible", timeout: 90_000 }],
      ["interactive.locator", ".xterm-helper-textarea"],
      ["input.waitFor", { state: "attached", timeout: 90_000 }],
    ]);
  });

  test("admits only concrete single-selector Axe targets to the manual contrast audit", () => {
    expect(axeManualContrastSelector(['button[class="bg-primary"]'])).toBe(
      'button[class="bg-primary"]',
    );
    expect(axeManualContrastSelector(["  div[data-description]  "])).toBe("div[data-description]");
    expect(axeManualContrastSelector([])).toBeNull();
    expect(axeManualContrastSelector([".host", ".shadow-child"])).toBeNull();
    expect(axeManualContrastSelector([""])).toBeNull();
    expect(axeManualContrastSelector(".bg-primary")).toBeNull();
  });

  test("ignores only expected browser-cancelled background reads", () => {
    const path = "/v1/workspaces/workspace/sessions/session/workspace/capture/file";
    expect(isExpectedBrowserCancellation(path, "net::ERR_ABORTED")).toBe(true);
    expect(
      isExpectedBrowserCancellation("/assets/analytics-consent-aB_09.js", "net::ERR_ABORTED"),
    ).toBe(true);
    expect(isExpectedBrowserCancellation("/v1/auth/get-session", "net::ERR_ABORTED")).toBe(true);
    expect(isExpectedBrowserCancellation(path, "net::ERR_FAILED")).toBe(false);
    expect(isExpectedBrowserCancellation("/assets/index-aB_09.js", "net::ERR_ABORTED")).toBe(false);
    expect(isExpectedBrowserCancellation("/v1/config/client", "net::ERR_ABORTED")).toBe(false);
  });

  test("keeps an open workspace open when Files hides the Changes panel", async () => {
    const selectors: string[] = [];
    let lookedUpCollapseControl = false;
    const page = {
      locator(selector: string) {
        selectors.push(selector);
        return { isVisible: async () => true };
      },
      getByRole() {
        lookedUpCollapseControl = true;
        throw new Error("should not look up a reopen control");
      },
    } as never;

    await openWorkspaceIfCollapsed(page);

    expect(selectors).toEqual(["[data-workspace-surface]"]);
    expect(lookedUpCollapseControl).toBe(false);
  });

  test("scopes restored file text to the file viewer when the transcript has duplicates", async () => {
    const calls: unknown[] = [];
    const page = {
      locator(selector: string) {
        calls.push(["locator", selector]);
        return {
          locator(innerSelector: string) {
            calls.push(["viewer.locator", innerSelector]);
            return {
              filter(options: { hasText: string }) {
                calls.push(["selected.filter", options]);
                return {
                  waitFor: async (waitOptions: { state: string; timeout: number }) => {
                    calls.push(["selected.waitFor", waitOptions]);
                  },
                  textContent: async () => {
                    calls.push(["selected.textContent"]);
                    return " api/base.txt ";
                  },
                };
              },
            };
          },
          getByText(text: string, options: { exact: boolean }) {
            calls.push(["viewer.getByText", text, options]);
            return {
              first() {
                calls.push(["viewer.first"]);
                return {
                  waitFor: async (waitOptions: { state: string; timeout: number }) => {
                    calls.push(["viewer.waitFor", waitOptions]);
                  },
                };
              },
            };
          },
        };
      },
      getByText() {
        throw new Error("must not match duplicate transcript or session-title text");
      },
    } as never;

    await waitForSandboxFileViewerText(page, "api/base.txt", "tracked but untouched", 30_000);

    expect(calls).toEqual([
      ["locator", "#sandbox-files-viewer"],
      ["viewer.locator", "[data-opengeni-selected-file]"],
      ["selected.filter", { hasText: "api/base.txt" }],
      ["selected.waitFor", { state: "visible", timeout: 30_000 }],
      ["selected.textContent"],
      ["viewer.getByText", "tracked but untouched", { exact: false }],
      ["viewer.first"],
      ["viewer.waitFor", { state: "visible", timeout: 30_000 }],
    ]);
  });

  test("observes the Changes default before requiring its layout to be visible", async () => {
    const calls: string[] = [];
    const page = {
      getByRole() {
        return {
          waitFor: async () => calls.push("tab.wait"),
        };
      },
      locator(selector: string) {
        if (selector === '[role="tab"][aria-selected="true"]') {
          return {
            filter: () => ({
              waitFor: async () => calls.push("selected-changes.wait"),
            }),
          };
        }
        expect(selector).toBe("[data-workbench-changes-layout]");
        return {
          waitFor: async (options: { state?: string; timeout?: number }) => {
            expect(options).toEqual({ state: "visible", timeout: 20_000 });
            calls.push("layout.wait");
          },
        };
      },
    } as never;

    await assertChangesDefaultVisible(page);

    expect(calls).toEqual(["tab.wait", "selected-changes.wait", "layout.wait"]);
  });

  test("keeps an expanded file-tree directory open when selecting another file", async () => {
    const clicks: string[] = [];
    const directoryButton = { click: async () => clicks.push("directory") };
    const fileButton = { click: async () => clicks.push("file") };
    const directoryItem = {
      isVisible: async () => true,
      getAttribute: async (name: string) => {
        expect(name).toBe("aria-expanded");
        return "true";
      },
      getByRole: () => ({ first: () => directoryButton }),
    };
    const fileItem = {
      isVisible: async () => true,
      getByRole: () => fileButton,
    };
    const page = {
      getByRole(role: string) {
        expect(role).toBe("treeitem");
        return {
          filter({ hasText }: { hasText: string }) {
            return { first: () => (hasText === "api" ? directoryItem : fileItem) };
          },
        };
      },
    } as never;

    await selectTreeFile(page, "api", "base.txt");

    expect(clicks).toEqual(["file"]);
  });

  test("selects an off-screen virtualized file through the tree keyboard contract", async () => {
    const presses: string[] = [];
    let active = 0;
    const rows = ["api", "base.txt", "notes.txt", "server.ts"];
    const directoryItem = {
      isVisible: async () => true,
      getAttribute: async () => "true",
      getByRole: () => ({ first: () => ({ click: async () => {} }) }),
    };
    const fileItem = {
      isVisible: async () => false,
    };
    const tree = {
      waitFor: async () => {},
      focus: async () => {},
      press: async (key: string) => {
        presses.push(key);
        if (key === "Home") active = 0;
        if (key === "ArrowDown") active = Math.min(active + 1, rows.length - 1);
      },
      getAttribute: async (name: string) => {
        expect(name).toBe("aria-activedescendant");
        return `tree-item-${active}`;
      },
    };
    const page = {
      getByRole(role: string) {
        if (role === "tree") return { first: () => tree };
        expect(role).toBe("treeitem");
        return {
          filter({ hasText }: { hasText: string }) {
            return { first: () => (hasText === "api" ? directoryItem : fileItem) };
          },
        };
      },
      locator(selector: string) {
        const index = Number(selector.match(/tree-item-(\d+)/)?.[1]);
        return {
          waitFor: async () => {},
          textContent: async () => rows[index] ?? null,
          getAttribute: async (name: string) => {
            if (name === "aria-level") return rows[index] === "api" ? "1" : "2";
            if (name === "aria-expanded") return rows[index] === "api" ? "true" : null;
            throw new Error(`unexpected attribute ${name}`);
          },
          getByText(text: string, options: { exact: boolean }) {
            expect(options).toEqual({ exact: true });
            return { count: async () => (rows[index] === text ? 1 : 0) };
          },
        };
      },
    } as never;

    await selectTreeFile(page, "api", "server.ts");

    expect(presses).toEqual(["Home", "ArrowDown", "ArrowDown", "ArrowDown", "Enter"]);
  });

  test("selects a file when its virtualized root directory is initially off-screen", async () => {
    const presses: string[] = [];
    let active = 0;
    let expanded = false;
    const rows = ["README.md", "api", "base.txt"];
    const tree = {
      waitFor: async () => {},
      focus: async () => {},
      press: async (key: string) => {
        presses.push(key);
        if (key === "Home") active = 0;
        if (key === "ArrowRight" && rows[active] === "api") expanded = true;
        if (key === "ArrowDown") active = Math.min(active + 1, rows.length - 1);
      },
      getAttribute: async (name: string) => {
        expect(name).toBe("aria-activedescendant");
        return `tree-item-${active}`;
      },
    };
    const page = {
      getByRole(role: string) {
        if (role === "tree") return { first: () => tree };
        expect(role).toBe("treeitem");
        return {
          filter: () => ({
            first: () => ({
              isVisible: async () => false,
            }),
          }),
        };
      },
      locator(selector: string) {
        const index = Number(selector.match(/tree-item-(\d+)/)?.[1]);
        return {
          waitFor: async () => {},
          textContent: async () => rows[index] ?? null,
          getAttribute: async (name: string) => {
            if (name === "aria-level") return rows[index] === "base.txt" ? "2" : "1";
            if (name === "aria-expanded") {
              return rows[index] === "api" && expanded ? "true" : "false";
            }
            throw new Error(`unexpected attribute ${name}`);
          },
          getByText(text: string, options: { exact: boolean }) {
            expect(options).toEqual({ exact: true });
            return { count: async () => (rows[index] === text ? 1 : 0) };
          },
        };
      },
    } as never;

    await selectTreeFile(page, "api", "base.txt");

    expect(presses).toEqual(["Home", "ArrowDown", "ArrowRight", "ArrowDown", "Enter"]);
  });

  test("waits for a cold virtualized tree to expose an active descendant", async () => {
    const presses: string[] = [];
    let active = 0;
    let hydrated = false;
    let readinessWaits = 0;
    const rows = ["api", "server.ts"];
    const tree = {
      waitFor: async (options: { state?: string; timeout?: number }) => {
        expect(options).toEqual({ state: "visible", timeout: 20_000 });
      },
      focus: async () => {},
      press: async (key: string) => {
        presses.push(key);
        if (key === "Home" && hydrated) active = 0;
        if (key === "ArrowDown") active = Math.min(active + 1, rows.length - 1);
      },
      getAttribute: async (name: string) => {
        expect(name).toBe("aria-activedescendant");
        return hydrated ? `tree-item-${active}` : null;
      },
    };
    const page = {
      getByRole(role: string) {
        if (role === "tree") return { first: () => tree };
        expect(role).toBe("treeitem");
        return {
          filter: () => ({
            first: () => ({
              isVisible: async () => false,
            }),
          }),
        };
      },
      locator(selector: string) {
        if (selector === '[role="tree"][aria-activedescendant]:not([aria-activedescendant=""])') {
          return {
            first: () => ({
              waitFor: async (options: { state?: string; timeout?: number }) => {
                expect(options).toEqual({ state: "visible", timeout: 20_000 });
                readinessWaits += 1;
                hydrated = true;
              },
            }),
          };
        }
        const index = Number(selector.match(/tree-item-(\d+)/)?.[1]);
        return {
          waitFor: async () => {},
          textContent: async () => rows[index] ?? null,
          getAttribute: async (name: string) => {
            if (name === "aria-level") return rows[index] === "api" ? "1" : "2";
            if (name === "aria-expanded") return rows[index] === "api" ? "true" : null;
            throw new Error(`unexpected attribute ${name}`);
          },
          getByText(text: string, options: { exact: boolean }) {
            expect(options).toEqual({ exact: true });
            return { count: async () => (rows[index] === text ? 1 : 0) };
          },
        };
      },
    } as never;

    await selectTreeFile(page, "api", "server.ts");

    expect(readinessWaits).toBe(1);
    expect(presses).toEqual(["Home", "Home", "ArrowDown", "Enter"]);
  });

  test("waits for an expanded lazy directory to finish hydrating its children", async () => {
    const presses: string[] = [];
    let active = 0;
    let expanded = false;
    let busy = false;
    let loaded = false;
    let hydrationWaits = 0;
    const rows = () => (loaded ? ["api", "server.ts"] : ["api"]);
    const tree = {
      waitFor: async () => {},
      focus: async () => {},
      press: async (key: string) => {
        presses.push(key);
        if (key === "Home") active = 0;
        if (key === "ArrowRight") {
          expanded = true;
          busy = true;
        }
        if (key === "ArrowDown") active = Math.min(active + 1, rows().length - 1);
      },
      getAttribute: async (name: string) => {
        expect(name).toBe("aria-activedescendant");
        return `tree-item-${active}`;
      },
    };
    const page = {
      getByRole(role: string) {
        if (role === "tree") return { first: () => tree };
        expect(role).toBe("treeitem");
        return {
          filter: () => ({
            first: () => ({
              isVisible: async () => false,
            }),
          }),
        };
      },
      locator(selector: string) {
        if (selector === '[id="tree-item-0"][aria-expanded="true"]:not([aria-busy="true"])') {
          return {
            waitFor: async (options: { state?: string; timeout?: number }) => {
              expect(options).toEqual({ state: "visible", timeout: 20_000 });
              expect(expanded).toBe(true);
              expect(busy).toBe(true);
              hydrationWaits += 1;
              busy = false;
              loaded = true;
            },
          };
        }
        const index = Number(selector.match(/tree-item-(\d+)/)?.[1]);
        return {
          waitFor: async () => {},
          textContent: async () => rows()[index] ?? null,
          getAttribute: async (name: string) => {
            if (name === "aria-level") return rows()[index] === "api" ? "1" : "2";
            if (name === "aria-expanded") return rows()[index] === "api" ? String(expanded) : null;
            if (name === "aria-busy") return rows()[index] === "api" ? String(busy) : null;
            throw new Error(`unexpected attribute ${name}`);
          },
          getByText(text: string, options: { exact: boolean }) {
            expect(options).toEqual({ exact: true });
            return { count: async () => (rows()[index] === text ? 1 : 0) };
          },
        };
      },
    } as never;

    await selectTreeFile(page, "api", "server.ts");

    expect(hydrationWaits).toBe(1);
    expect(presses).toEqual(["Home", "ArrowRight", "ArrowDown", "Enter"]);
  });

  test("reports bounded tree observations when a target directory is absent", async () => {
    const presses: string[] = [];
    let active = 0;
    const rows = Array.from(
      { length: 10 },
      (_, index) => `root-${String(index).padStart(2, "0")}-${"x".repeat(120)}`,
    );
    const tree = {
      waitFor: async () => {},
      focus: async () => {},
      press: async (key: string) => {
        presses.push(key);
        if (key === "Home") active = 0;
        if (key === "ArrowDown") active = Math.min(active + 1, rows.length - 1);
      },
      getAttribute: async (name: string) => {
        expect(name).toBe("aria-activedescendant");
        return `tree-item-${active}`;
      },
    };
    const page = {
      getByRole(role: string) {
        if (role === "tree") return { first: () => tree };
        expect(role).toBe("treeitem");
        return {
          filter: () => ({
            first: () => ({
              isVisible: async () => false,
            }),
          }),
        };
      },
      locator(selector: string) {
        const index = Number(selector.match(/tree-item-(\d+)/)?.[1]);
        return {
          waitFor: async () => {},
          textContent: async () => rows[index] ?? null,
          getAttribute: async (name: string) => {
            if (name === "aria-level") return "1";
            if (name === "aria-expanded") return "false";
            throw new Error(`unexpected attribute ${name}`);
          },
          getByText(text: string, options: { exact: boolean }) {
            expect(options).toEqual({ exact: true });
            return { count: async () => (rows[index] === text ? 1 : 0) };
          },
        };
      },
    } as never;

    let failure: unknown;
    try {
      await selectTreeFile(page, "api", "server.ts");
    } catch (error) {
      failure = error;
    }

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toContain(
      "file tree could not select api/server.ts: navigation stalled at the tree boundary",
    );
    expect((failure as Error).message).not.toContain("root-00");
    expect((failure as Error).message).not.toContain("root-01");
    expect((failure as Error).message).toContain('"label":"root-02-');
    expect((failure as Error).message).toContain('"label":"root-09-');
    expect((failure as Error).message).toContain('"level":1');
    expect(presses).toEqual(["Home", ...Array.from({ length: 10 }, () => "ArrowDown")]);
    expect((failure as Error).message.length).toBeLessThan(2_000);
  });

  test("accepts repository evidence from the compact changed-file picker", async () => {
    const calls: string[] = [];
    const page = {
      locator(selector: string) {
        if (selector === "[data-workbench-changes-layout]") {
          return {
            getAttribute: async () => "compact",
          };
        }
        expect(selector).toBe("[data-compact-file-picker]");
        return {
          waitFor: async (options: { state?: string; timeout?: number }) => {
            expect(options).toEqual({ state: "visible", timeout: 20_000 });
            calls.push("picker.wait");
          },
          locator(optionSelector: string) {
            expect(optionSelector).toBe("option");
            return {
              allTextContents: async () => ["M · server.ts — api/", "M · app.tsx — web/src/"],
            };
          },
        };
      },
      getByText() {
        throw new Error("compact mode must not require hidden repository group labels");
      },
    } as never;

    await assertRepositoryChangesVisible(page, ["api", "web"]);

    expect(calls).toEqual(["picker.wait"]);
  });

  test("fails closed when compact changes omit an expected repository", () => {
    expect(() =>
      assertChangedFileLabelsContainRepositoryRoots(["M · server.ts — api/"], ["api", "web"]),
    ).toThrow("compact workbench changes omitted repository web");
  });

  test("rejects the protected manually used production account", () => {
    const protectedEmails = parseProtectedEmails("manually-used@example.com");
    expect(() =>
      assertDedicatedCanaryEmail(
        "manually-used@example.com",
        "manually-used@example.com",
        protectedEmails,
      ),
    ).toThrow("protected manually used account");
    expect(() =>
      assertDedicatedCanaryEmail(
        "acceptance@example.com",
        "manually-used@example.com",
        protectedEmails,
      ),
    ).toThrow("protected manually used account");
    expect(() => parseProtectedEmails("  ,  ")).toThrow("must list valid protected accounts");
  });

  test("requires the exact dedicated canary email", () => {
    const protectedEmails = parseProtectedEmails("manually-used@example.com");
    expect(
      assertDedicatedCanaryEmail(
        "acceptance@example.com",
        "acceptance@example.com",
        protectedEmails,
      ),
    ).toBe("acceptance@example.com");
    expect(() =>
      assertDedicatedCanaryEmail("other@example.com", "acceptance@example.com", protectedEmails),
    ).toThrow("does not match");
    expect(parseProtectedEmails(" First@example.com,SECOND@example.com ")).toEqual(
      new Set(["first@example.com", "second@example.com"]),
    );
  });

  test("enforces HTTPS, a full SHA, Modal, and at least 100 repetitions", () => {
    const base = [
      "--api-url",
      "https://api.example.com",
      "--web-url",
      "https://app.example.com",
      "--environment",
      "staging",
      "--source-sha",
      "a".repeat(40),
      "--run-id",
      "acceptance-001",
      "--model",
      "codex/model",
      "--capture-api-region-probe-command",
      "/tmp/capture-api-regional-probe.ts",
      "--capture-api-region",
      "northeurope",
      "--capture-api-image",
      `registry.example.com/opengeni-api:candidate-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
    ];
    expect(parseLiveAcceptanceArgs(base).repetitions).toBe(100);
    expect(() => parseLiveAcceptanceArgs([...base, "--repetitions", "99"])).toThrow(">= 100");
    expect(() => parseLiveAcceptanceArgs(base.with(1, "http://api.example.com"))).toThrow("HTTPS");
  });

  test("binds capture API samples to the exact regional deployment identity", () => {
    const request = captureApiRegionalProbeRequest();
    const result = captureApiRegionalProbeResult(request);
    expect(validateCaptureApiRegionalProbeResult(result, request)).toEqual(result);
    expect(result.captureTurnId).toBe(request.captureTurnId);
    expect(() =>
      validateCaptureApiRegionalProbeResult({ ...result, region: "westus" }, request),
    ).toThrow("region mismatch");
    expect(() =>
      validateCaptureApiRegionalProbeResult(
        { ...result, samplesMs: result.samplesMs.slice(1) },
        request,
      ),
    ).toThrow("sample count mismatch");
    expect(() =>
      validateCaptureApiRegionalProbeResult({ ...result, extra: true }, request),
    ).toThrow("fields are invalid");
  });

  test("passes the managed cookie only over probe stdin and masks it from public child failures", async () => {
    const directory = await mkdtemp(resolve(tmpdir(), "opengeni-regional-probe-"));
    const success = resolve(directory, "success.ts");
    const failure = resolve(directory, "failure.ts");
    const request = captureApiRegionalProbeRequest();
    try {
      await writeFile(
        success,
        `const request = JSON.parse(await Bun.stdin.text());\n` +
          `if (process.env.OPENGENI_ACCEPTANCE_SESSION_COOKIE) throw new Error("cookie leaked through environment");\n` +
          `process.stdout.write(JSON.stringify({\n` +
          `  schemaVersion: "opengeni/workbench-capture-api-regional-probe/v1",\n` +
          `  apiOrigin: new URL(request.apiUrl).origin, environment: request.environment,\n` +
          `  sourceSha: request.sourceSha, runId: request.runId, workspaceId: request.workspaceId,\n` +
          `  sessionId: request.sessionId, captureRevision: request.captureRevision,\n` +
          `  captureTurnId: request.captureTurnId, sampleCount: request.repetitions,\n` +
          `  region: request.region, apiImage: request.apiImage, decodedBytes: 4096,\n` +
          `  contentEncoding: "gzip", samplesMs: Array(request.repetitions).fill(12.5)\n` +
          `}));\n`,
      );
      await writeFile(
        failure,
        `const request = JSON.parse(await Bun.stdin.text());\n` +
          `console.error(request.cookieHeader);\nprocess.exit(7);\n`,
      );

      const result = await runCaptureApiRegionalProbe(success, request);
      expect(result.sampleCount).toBe(request.repetitions);
      expect(JSON.stringify(result)).not.toContain(request.cookieHeader);
      const failureMessage = await runCaptureApiRegionalProbe(failure, request).then(
        () => "unexpected success",
        (error: unknown) => (error instanceof Error ? error.message : String(error)),
      );
      expect(failureMessage).toContain("exit code 7: [masked]");
      expect(failureMessage).not.toContain(request.cookieHeader);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("strips every acceptance secret from the regional probe environment", () => {
    expect(
      captureApiRegionalProbeEnvironment({
        PATH: "/usr/bin",
        KUBECONFIG: "/tmp/kubeconfig",
        OPENGENI_CAPTURE_API_PROBE_NAMESPACE: "opengeni",
        OPENGENI_ACCEPTANCE_SESSION_COOKIE: "secret-cookie",
        OPENGENI_ACCEPTANCE_PRODUCT_TOKEN: "secret-token",
        UNDEFINED_VALUE: undefined,
      }),
    ).toEqual({
      PATH: "/usr/bin",
      KUBECONFIG: "/tmp/kubeconfig",
      OPENGENI_CAPTURE_API_PROBE_NAMESPACE: "opengeni",
    });
  });

  test("cookie parsing stays exact and public evidence masks only exact known values", () => {
    expect(parseCookieHeader("better-auth.session_token=a.b%3D; second=x=y")).toEqual([
      { name: "better-auth.session_token", value: "a.b%3D" },
      { name: "second", value: "x=y" },
    ]);
    expect(
      maskKnownPublicEvidenceValues("cookie=known-value; unrelated=Bearer abc.def", [
        "known-value",
      ]),
    ).toBe("cookie=[masked]; unrelated=Bearer abc.def");
  });

  test("control cancellation timing fails closed on invalid or impossible event order", () => {
    expect(controlCancellationDurationMs(1_000, 1_125)).toBe(125);
    expect(() => controlCancellationDurationMs(1_000, 999)).toThrow("before its control commit");
    expect(() => controlCancellationDurationMs(Number.NaN, 1_000)).toThrow("must be finite");
  });

  test("liveness polling bounds and retries a transient transport failure", async () => {
    const signals: AbortSignal[] = [];
    let calls = 0;
    const client = {
      async getStreamCapabilities(
        _workspaceId: string,
        _sessionId: string,
        options: { signal?: AbortSignal } = {},
      ) {
        if (options.signal) signals.push(options.signal);
        calls += 1;
        if (calls === 1) throw new DOMException("request timed out", "TimeoutError");
        return { liveness: "cold" } as never;
      },
    };

    await waitForSandboxLiveness(
      client,
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      new Set(["cold"]),
      1_000,
      0,
      50,
    );

    expect(calls).toBe(2);
    expect(signals).toHaveLength(2);
  });

  test("does not call a draining lease cold before teardown completes", async () => {
    let calls = 0;
    const client = {
      async getStreamCapabilities() {
        calls += 1;
        return { liveness: calls === 1 ? "draining" : "cold" } as never;
      },
    };

    await waitForCold(
      client,
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      1_000,
      0,
      50,
    );

    expect(calls).toBe(2);
  });

  test("does not call a draining lease warm before deliberate wake completes", async () => {
    let calls = 0;
    const client = {
      async getStreamCapabilities() {
        calls += 1;
        return { liveness: calls === 1 ? "draining" : "warm" } as never;
      },
    };

    await waitForWarm(
      client,
      "10000000-0000-4000-8000-000000000001",
      "20000000-0000-4000-8000-000000000002",
      1_000,
      0,
      50,
    );

    expect(calls).toBe(2);
  });

  test("requires interactive scopes only from the dedicated canary principal", () => {
    const workspaceId = "10000000-0000-4000-8000-000000000001";
    const canary = accessContext(workspaceId, [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "files:read",
      "files:write",
      "stream:view",
      "stream:acknowledge",
      "terminal:attach",
    ]);
    const probe = accessContext(workspaceId, [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
    ]);

    expect(() => assertAcceptancePrincipalScopes(canary, probe, workspaceId)).not.toThrow();
    expect(() =>
      assertAcceptancePrincipalScopes(
        accessContext(workspaceId, [
          "workspace:read",
          "sessions:create",
          "sessions:read",
          "sessions:control",
        ]),
        probe,
        workspaceId,
      ),
    ).toThrow("acceptance workbench canary lacks: files:read");
    expect(() =>
      assertAcceptancePrincipalScopes(
        canary,
        accessContext(workspaceId, ["workspace:read", "sessions:create"]),
        workspaceId,
      ),
    ).toThrow("acceptance observability probe lacks: sessions:read");
  });

  test("the fixture and its verifier fail closed across the documented boundary matrix", () => {
    const marker = "OPENGENI_WORKBENCH_ACCEPTANCE_001";
    const prompt = fixturePrompt(marker);
    for (const required of [
      "web-linked",
      "nested/deep/repo",
      "\\303\\274ber \\316\\273.txt",
      "server-link.ts",
      "external-link",
      "external-dir",
      "node_modules",
      "chmod +x",
    ]) {
      expect(prompt).toContain(required);
    }

    const manifest = fixtureManifest(marker);
    expect(() => assertFixtureCapture(manifest, marker)).not.toThrow();

    manifest.repos.find((repo) => repo.root === "web")!.status = manifest.repos
      .find((repo) => repo.root === "web")!
      .status.filter((item) => item.path !== "renamed.txt");
    expect(() => assertFixtureCapture(manifest, marker)).toThrow("renamed fixture status drifted");
  });

  test("requires the exact fixture marker in a tool output", () => {
    const marker = "OPENGENI_WORKBENCH_ACCEPTANCE_001";
    const event = {
      type: "agent.toolCall.output",
      payload: { output: `setup complete\n${marker}\n` },
    } as never;
    expect(() => assertFixtureToolOutput([event], marker)).not.toThrow();
    expect(() =>
      assertFixtureToolOutput(
        [{ type: "agent.message.completed", payload: { text: marker } } as never],
        marker,
      ),
    ).toThrow("acceptance fixture command did not emit its exact marker");
  });
});

function accessContext(
  workspaceId: string,
  permissions: AccessContext["workspaceGrants"][number]["permissions"],
): AccessContext {
  return {
    mode: "managed",
    subjectId: "acceptance:test",
    accountGrants: [],
    workspaceGrants: [
      {
        workspaceId,
        accountId: "20000000-0000-4000-8000-000000000002",
        subjectId: "acceptance:test",
        permissions,
      },
    ],
    defaultAccountId: "20000000-0000-4000-8000-000000000002",
    defaultWorkspaceId: workspaceId,
  };
}

function fixtureManifest(marker: string): WorkspaceCaptureManifest {
  const content = new Map<string, Uint8Array>([
    [
      "api/server.ts",
      Buffer.from(`export const marker = "${marker}";\nexport const status = 204;\n`),
    ],
    ["api/notes.txt", Buffer.from(`untracked ${marker}\n`)],
    ["api/empty.txt", Buffer.alloc(0)],
    ["api/binary.dat", Buffer.from([0, 1, 254, 255])],
    ["api/signed-preview.txt", Buffer.alloc(307_200, "s")],
    ["api/run.sh", Buffer.from(`#!/bin/sh\necho ${marker}\n`)],
    [
      "api/server-link.ts",
      Buffer.from(`export const marker = "${marker}";\nexport const status = 204;\n`),
    ],
    ["api/über λ.txt", Buffer.from(`unicode ${marker}\n`)],
    ["web/app.js", Buffer.from(`console.log("staged and unstaged ${marker}");\n`)],
    ["web/renamed.txt", Buffer.from("rename me\n")],
    ["web-linked/worktree-marker.txt", Buffer.from(`linked ${marker}\n`)],
    ["nested/deep/repo/deep.txt", Buffer.from(`deep ${marker}\n`)],
  ]);
  const file = (
    path: string,
    status: WorkspaceCaptureManifest["files"][number]["status"] = "modified",
  ): WorkspaceCaptureManifest["files"][number] => {
    const bytes = content.get(path)!;
    return {
      path,
      status,
      hash: hash(bytes),
      baseHash: null,
      contentRef: `fixture/${encodeURIComponent(path)}`,
      sizeBytes: bytes.byteLength,
      isBinary: path === "api/binary.dat",
      tooLarge: false,
      deleted: false,
    };
  };
  const diff = (
    path: string,
    text: string,
  ): WorkspaceCaptureManifest["repos"][number]["diff"][number] => ({
    path,
    oldPath: null,
    status: path.startsWith("external-") ? "untracked" : "modified",
    isBinary: false,
    isImage: false,
    additions: 1,
    deletions: 0,
    truncated: false,
    hunks: [
      {
        oldStart: 0,
        oldLines: 0,
        newStart: 1,
        newLines: 1,
        header: "@@ -0,0 +1 @@",
        lines: [{ type: "add", oldNo: null, newNo: 1, text }],
      },
    ],
  });
  const status = (
    path: string,
    index: WorkspaceCaptureManifest["repos"][number]["status"][number]["index"],
    worktree: WorkspaceCaptureManifest["repos"][number]["status"][number]["worktree"],
    oldPath: string | null = null,
  ) => ({ path, oldPath, index, worktree, isConflicted: false });
  const repo = (
    root: string,
    statuses: WorkspaceCaptureManifest["repos"][number]["status"],
    diffs: WorkspaceCaptureManifest["repos"][number]["diff"] = [],
  ): WorkspaceCaptureManifest["repos"][number] => ({
    root,
    head: "main",
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    status: statuses,
    diff: diffs,
  });
  const treeNode = (
    path: string,
    type: WorkspaceCaptureManifest["treeIndex"]["type"] = "file",
    mode = 0o644,
  ): WorkspaceCaptureManifest["treeIndex"] => ({
    name: path.split("/").at(-1)!,
    path,
    type,
    sizeBytes: type === "dir" ? null : 1,
    mtimeMs: 1,
    mode,
    truncated: false,
  });

  return {
    version: 1,
    revision: 1,
    capturedAt: "2026-07-16T00:00:00.000Z",
    turnId: null,
    leaseEpoch: 1,
    treeIndex: {
      ...treeNode("", "dir", 0o755),
      children: [
        treeNode("api/server-link.ts", "symlink"),
        treeNode("api/external-link", "symlink"),
        treeNode("api/external-dir", "symlink"),
        treeNode("api/run.sh", "file", 0o755),
        treeNode("api/über λ.txt"),
      ],
    },
    treeTruncated: false,
    repos: [
      repo(
        "api",
        [
          status("server.ts", null, "modified"),
          status("notes.txt", null, "untracked"),
          status("external-link", null, "untracked"),
          status("external-dir", null, "untracked"),
        ],
        [
          diff("server.ts", marker),
          diff("external-link", `/tmp/opengeni-${marker}`),
          diff("external-dir", `/tmp/opengeni-dir-${marker}`),
        ],
      ),
      repo("web", [
        status("app.js", "modified", "modified"),
        status("renamed.txt", "renamed", null, "old-name.txt"),
        status("deleted.txt", "deleted", null),
      ]),
      repo("web-linked", [status("worktree-marker.txt", null, "untracked")]),
      repo("nested/deep/repo", [status("deep.txt", null, "modified")]),
    ],
    files: [
      file("api/server.ts"),
      file("api/notes.txt", "untracked"),
      file("api/empty.txt", "untracked"),
      file("api/binary.dat", "untracked"),
      file("api/signed-preview.txt", "untracked"),
      {
        path: "api/too-large.bin",
        status: "untracked",
        hash: null,
        baseHash: null,
        contentRef: null,
        sizeBytes: 5 * 1024 * 1024,
        isBinary: true,
        tooLarge: true,
        deleted: false,
      },
      file("api/run.sh"),
      file("api/server-link.ts", "untracked"),
      file("api/über λ.txt", "untracked"),
      file("web/app.js"),
      file("web/renamed.txt", "renamed"),
      {
        path: "web/deleted.txt",
        status: "deleted",
        hash: null,
        baseHash: null,
        contentRef: null,
        sizeBytes: 0,
        isBinary: false,
        tooLarge: false,
        deleted: true,
      },
      file("web-linked/worktree-marker.txt", "untracked"),
      file("nested/deep/repo/deep.txt"),
    ],
    stats: {
      repoCount: 4,
      fileCount: 14,
      additions: 1,
      deletions: 1,
      totalBytes: 1,
      tooLargeCount: 1,
      binaryCount: 1,
      treeEntryCount: 4,
      treeTruncated: false,
      durationMs: 1,
    },
  };
}

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function captureApiRegionalProbeRequest(): CaptureApiRegionalProbeRequest {
  return {
    schemaVersion: "opengeni/workbench-capture-api-regional-probe-request/v1",
    apiUrl: "https://app.example.com",
    environment: "production",
    sourceSha: "a".repeat(40),
    runId: "production-12345-1",
    workspaceId: "11111111-1111-4111-8111-111111111111",
    sessionId: "22222222-2222-4222-8222-222222222222",
    captureRevision: 7,
    captureTurnId: "33333333-3333-4333-8333-333333333333",
    repetitions: 100,
    region: "northeurope",
    apiImage: `registry.example.com/opengeni-api:candidate-${"a".repeat(40)}@sha256:${"b".repeat(64)}`,
    cookieHeader: "better-auth.session_token=secret-cookie",
  };
}

function captureApiRegionalProbeResult(request: CaptureApiRegionalProbeRequest) {
  return {
    schemaVersion: "opengeni/workbench-capture-api-regional-probe/v1" as const,
    apiOrigin: new URL(request.apiUrl).origin,
    environment: request.environment,
    sourceSha: request.sourceSha,
    runId: request.runId,
    workspaceId: request.workspaceId,
    sessionId: request.sessionId,
    captureRevision: request.captureRevision,
    captureTurnId: request.captureTurnId,
    sampleCount: request.repetitions,
    region: request.region,
    apiImage: request.apiImage,
    decodedBytes: 4096,
    contentEncoding: "gzip" as const,
    samplesMs: Array(request.repetitions).fill(12.5),
  };
}
