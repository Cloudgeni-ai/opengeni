import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserAction,
  BrowserActionBatch,
  BrowserActionCommand,
  BrowserActionResolvedTarget,
  BrowserObservation,
} from "@opengeni/contracts";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

// A page whose header and modal dialog both have a "Close" button. While the
// dialog is open, only its button is reachable; once it is gone, the same
// locator resolves to the header's button.
const fixture = `data:text/html,${encodeURIComponent(`<!doctype html>
<header><button onclick="document.title='header closed'">Close</button></header>
<main>
  <button onclick="document.getElementById('editor').showModal()">Edit</button>
  <input data-testid="note" aria-label="Note">
</main>
<dialog id="editor" aria-label="Edit item">
  <button onclick="this.closest('dialog').close()">Close</button>
</dialog>`)}`;

e2e(
  "receipts record which element each locator resolved to and where it sits",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-resolved-target-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `rt_${randomUUID().slice(0, 8)}`,
      sessionName: "s",
      socketDirectory: join(directory, "s"),
      profileDirectory: join(directory, "profile"),
      downloadDirectory: join(directory, "downloads"),
      screenshotDirectory: join(directory, "screenshots"),
      headed: false,
      binary: await resolvePinnedAgentBrowserBinary(
        process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY
          ? { binaryPath: process.env.OPENGENI_BROWSERD_AGENT_BROWSER_BINARY }
          : {},
      ),
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
    });
    const command = (
      observed: BrowserObservation,
      action: BrowserAction | BrowserActionBatch,
    ): BrowserActionCommand => ({
      protocolVersion: 1,
      operationId: randomUUID(),
      browserSessionId: observed.browserSessionId,
      controllerGeneration: observed.target.controllerGeneration,
      targetId: observed.target.id,
      expectedTargetGeneration: observed.target.targetGeneration,
      expectedDocumentGeneration: observed.target.documentGeneration,
      expectedFrameId: observed.frameId,
      actor: { kind: "system", subjectId: "public-resolved-target-fixture" },
      action,
    });
    const traced = async (
      observed: BrowserObservation,
      action: BrowserAction | BrowserActionBatch,
    ) => {
      const targets: BrowserActionResolvedTarget[] = [];
      const next = await driver.dispatch(command(observed, action), {
        record: (item) => targets.push(item as BrowserActionResolvedTarget),
      });
      return { next, targets };
    };
    const close = {
      type: "click",
      locator: { kind: "role", role: "button", name: "Close", exact: true },
    } as const;
    try {
      let observed = await driver.start(fixture);

      // Untraced dispatch behaves exactly as before.
      observed = await driver.dispatch(
        command(observed, {
          type: "click",
          locator: { kind: "role", role: "button", name: "Edit", exact: true },
        }),
      );

      const inDialog = await traced(observed, close);
      expect(inDialog.targets).toHaveLength(1);
      expect(inDialog.targets[0]).toMatchObject({
        actionIndex: 0,
        role: "button",
        name: "Close",
        container: { role: "dialog", name: "Edit item" },
      });
      expect(inDialog.targets[0]!.ref).toEqual(expect.any(String));
      expect(inDialog.next.target.title).not.toBe("header closed");

      // The dialog is gone: the identical locator now acts on the header.
      const inHeader = await traced(inDialog.next, close);
      expect(inHeader.targets).toEqual([
        expect.objectContaining({
          actionIndex: 0,
          role: "button",
          name: "Close",
          container: { role: "banner", name: null },
        }),
      ]);
      expect(inHeader.next.target.title).toBe("header closed");

      // DOM-resolved locators are described from the accessibility tree, and a
      // batch reports each action by index.
      const batch = await traced(inHeader.next, {
        type: "batch",
        actions: [
          {
            type: "fill",
            locator: { kind: "test_id", value: "note" },
            value: "hello",
          },
          {
            type: "click",
            locator: {
              kind: "role",
              role: "button",
              name: "Edit",
              exact: true,
            },
          },
        ],
      });
      expect(batch.targets).toEqual([
        {
          actionIndex: 0,
          ref: null,
          role: "textbox",
          name: "Note",
          container: { role: "main", name: null },
        },
        expect.objectContaining({
          actionIndex: 1,
          role: "button",
          name: "Edit",
          container: { role: "main", name: null },
        }),
      ]);
    } finally {
      await driver.close().catch(() => undefined);
      await rm(directory, { recursive: true, force: true });
    }
  },
  120_000,
);
