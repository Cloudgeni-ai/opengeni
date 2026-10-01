import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import {
  AgentBrowserDriver,
  AgentBrowserJsonRunner,
  resolvePinnedAgentBrowserBinary,
} from "../src";
import { CdpConnection, CdpProtocolError } from "../src/cdp";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

e2e(
  "revalidates Chromium references without a full pre-action tree or stale-node input",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-reference-");
    const runner = await AgentBrowserJsonRunner.create({
      namespace: `ref_${randomUUID().slice(0, 8)}`,
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
    const calls: string[] = [];
    let mutation: string | null = null;
    let unsupported = false;
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: randomUUID(),
      runner,
      async connect(endpoint) {
        const connection = await CdpConnection.connect(endpoint);
        const originalSend = connection.send.bind(connection);
        connection.send = async <T>(
          method: string,
          params?: Readonly<Record<string, unknown>>,
          options?: Parameters<CdpConnection["send"]>[2],
        ): Promise<T> => {
          calls.push(method);
          if (method === "Accessibility.getPartialAXTree") {
            if (unsupported) throw new CdpProtocolError(method, -32601, "unsupported method");
            if (mutation) {
              const expression = mutation;
              mutation = null;
              await originalSend("Runtime.evaluate", { expression }, options);
            }
          }
          return await originalSend<T>(method, params, options);
        };
        return connection;
      },
    });
    const fixture = `data:text/html,${encodeURIComponent('<!doctype html><button id="target" onclick="this.textContent=\'Clicked\'">Click</button>' + "<p>Unrelated content</p>".repeat(500))}`;
    const click = (observed: BrowserObservation): BrowserActionCommand => {
      const pending: InteractionSemanticNodeValue[] = [
        ...(observed.semantic?.kind === "snapshot" ? observed.semantic.roots : []),
      ];
      let ref: string | undefined;
      while (pending.length) {
        const node = pending.pop()!;
        if (node.role === "button") ref = node.ref;
        if (node.children) pending.push(...node.children);
      }
      if (!ref) throw new Error("Missing fixture button");
      return {
        protocolVersion: 1,
        operationId: randomUUID(),
        browserSessionId: observed.browserSessionId,
        controllerGeneration: observed.target.controllerGeneration,
        targetId: observed.target.id,
        expectedTargetGeneration: observed.target.targetGeneration,
        expectedDocumentGeneration: observed.target.documentGeneration,
        expectedFrameId: observed.frameId!,
        actor: { kind: "system", subjectId: "public-ref-fixture" },
        action: { type: "click", locator: { kind: "ref", ref } },
      };
    };
    try {
      let observed = await driver.start(fixture);
      calls.length = 0;
      const result = await driver.dispatch(click(observed));
      expect(JSON.stringify(result.semantic)).toContain("Clicked");
      expect(calls.filter((method) => method === "Accessibility.getPartialAXTree")).toHaveLength(1);
      // The full post-action observation remains; only the redundant pre-input
      // tree is removed. This test fails against the old implementation.
      expect(calls.filter((method) => method === "Accessibility.getFullAXTree")).toHaveLength(1);

      for (const expression of [
        "document.querySelector('#target').style.display='none'",
        "document.querySelector('#target').outerHTML='<button>Replacement</button>'",
      ]) {
        observed = await driver.openTarget(fixture);
        mutation = expression;
        calls.length = 0;
        await expect(driver.dispatch(click(observed))).rejects.toMatchObject({
          code: "locator_not_found",
        });
        expect(calls.filter((method) => method.startsWith("Input."))).toHaveLength(0);
      }
      observed = await driver.openTarget(fixture);
      unsupported = true;
      calls.length = 0;
      expect(JSON.stringify((await driver.dispatch(click(observed))).semantic)).toContain(
        "Clicked",
      );
      expect(calls.filter((method) => method === "Accessibility.getFullAXTree")).toHaveLength(2);
    } finally {
      await driver.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  60_000,
);
