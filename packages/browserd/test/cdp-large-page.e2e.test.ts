import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import type {
  BrowserActionCommand,
  BrowserObservation,
  InteractionSemanticNodeValue,
} from "@opengeni/contracts";
import { INTERACTION_MAX_SEMANTIC_NODES } from "@opengeni/contracts";
import { AgentBrowserDriver, ManagedBrowserRunner } from "../src";

const e2e = process.env.OPENGENI_BROWSERD_E2E === "1" ? test : test.skip;

const html = (body: string) =>
  new Response(`<!doctype html><meta charset="utf-8">${body}`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/** A neutral admin console with a very large resource table. */
function tablePage(rows: number): Response {
  const body: string[] = [];
  for (let index = 0; index < rows; index += 1) {
    body.push(
      `<tr id="row-${index}"><td><input type="checkbox" aria-label="Select instance-${index}"></td>` +
        `<td><a href="#detail-${index}">instance-${index}</a></td><td>zone-a</td>` +
        `<td><button aria-haspopup="menu" aria-label="More actions for instance-${index}">⋮</button></td></tr>`,
    );
  }
  return html(
    `<title>Instances</title><style>td{padding:0;height:20px;line-height:20px}table{border-collapse:collapse}</style><nav aria-label="Console"><a href="#home">Home</a></nav>` +
      `<main><h1>Instances</h1><button>Create instance</button><table>${body.join("")}</table></main>`,
  );
}

function names(nodes: readonly InteractionSemanticNodeValue[] | undefined): string[] {
  const found: string[] = [];
  const visit = (list: readonly InteractionSemanticNodeValue[]) => {
    for (const node of list) {
      if (node.name) found.push(node.name);
      if (node.children) visit(node.children);
    }
  };
  visit(nodes ?? []);
  return found;
}

function snapshot(observation: BrowserObservation) {
  if (observation.semantic?.kind !== "snapshot") throw new Error("expected a snapshot");
  return observation.semantic;
}

function command(
  observation: BrowserObservation,
  action: BrowserActionCommand["action"],
): BrowserActionCommand {
  return {
    protocolVersion: 1,
    operationId: randomUUID(),
    browserSessionId: observation.browserSessionId,
    controllerGeneration: observation.target.controllerGeneration,
    targetId: observation.target.id,
    expectedTargetGeneration: observation.target.targetGeneration,
    expectedDocumentGeneration: observation.target.documentGeneration,
    expectedFrameId: observation.frameId!,
    actor: { kind: "agent", subjectId: "browserd-large-page-e2e" },
    action,
  };
}

e2e(
  "a very large page is read within bounds and one oversized message never ends the browser connection",
  async () => {
    const directory = await mkdtemp("/tmp/ogb-large-page-");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        const url = new URL(request.url);
        if (url.pathname === "/table") return tablePage(6_000);
        if (url.pathname === "/names") {
          // Few elements, each with a very long accessible name: the page
          // looks small, but its whole tree is one message over 32 MiB.
          const long = "detail ".repeat(900);
          const buttons = Array.from(
            { length: 4_000 },
            (_, index) => `<button aria-label="Action ${index} ${long}">${index}</button>`,
          );
          return html(`<title>Names</title><h1>Long names</h1>${buttons.join("")}`);
        }
        if (url.pathname === "/log") {
          // One console message of 40 MB: an event over the message bound.
          return html(
            `<title>Log</title><button>Logged</button><script>console.log("x".repeat(40000000))</script>`,
          );
        }
        return html(`<title>Other</title><button>Other tab</button>`);
      },
    });
    const base = `http://127.0.0.1:${server.port}`;
    const runner = await ManagedBrowserRunner.create({
      profileDirectory: join(directory, "profile"),
      headed: false,
      ...(process.env.OPENGENI_BROWSER_EXECUTABLE
        ? { browserExecutablePath: process.env.OPENGENI_BROWSER_EXECUTABLE }
        : {}),
    });
    const driver = new AgentBrowserDriver({
      browserSessionId: randomUUID(),
      controllerGeneration: `controller-${randomUUID()}`,
      runner,
    });
    try {
      const other = await driver.start(`${base}/other`);
      const otherTab = async () => {
        const observed = await driver.observe(other.target.id);
        expect(observed.target.id).toBe(other.target.id);
        expect(names(snapshot(observed).roots)).toContain("Other tab");
      };

      // A table of 6,000 rows: its page structure and the rows on screen.
      const table = await driver.openTarget(`${base}/table`);
      const tableSnapshot = snapshot(table);
      expect(tableSnapshot.incomplete).toMatchObject({ reason: "node_budget" });
      expect(tableSnapshot.incomplete!.unreadCount).toBeGreaterThan(1_000);
      expect(tableSnapshot.nodeCount).toBeLessThanOrEqual(INTERACTION_MAX_SEMANTIC_NODES);
      const top = names(tableSnapshot.roots);
      expect(top).toContain("Create instance");
      expect(top).toContain("Select instance-0");
      expect(top).not.toContain("Select instance-5000");
      await otherTab();

      // Scrolling far down brings those rows into the outline, and a locator
      // for one of them acts on it.
      const scrolled = await driver.dispatch(
        command(table, { type: "scroll", deltaX: 0, deltaY: 100_000 }),
      );
      const rowsShown = (observation: BrowserObservation) =>
        names(snapshot(observation).roots).flatMap((name) => {
          const match = /^Select instance-(\d+)$/u.exec(name);
          return match ? [Number(match[1])] : [];
        });
      const lower = rowsShown(await driver.observe(scrolled!.target.id));
      expect(Math.min(...lower)).toBeGreaterThan(4_000);
      const target = `Select instance-${lower[Math.floor(lower.length / 2)]}`;
      const checked = await driver.dispatch(
        command(await driver.observe(table.target.id), {
          type: "click",
          locator: { kind: "role", role: "checkbox", name: target },
        }),
      );
      const box = (function find(
        nodes: readonly InteractionSemanticNodeValue[],
      ): InteractionSemanticNodeValue | null {
        for (const node of nodes) {
          if (node.name === target && node.role === "checkbox") return node;
          const inner = node.children ? find(node.children) : null;
          if (inner) return inner;
        }
        return null;
      })(snapshot(await driver.observe(checked!.target.id)).roots);
      expect(box?.states).toContain("checked");

      // A page whose whole tree is one oversized response is read bounded too.
      const longNames = await driver.openTarget(`${base}/names`);
      expect(snapshot(longNames).incomplete).toMatchObject({ reason: "node_budget" });
      expect(names(snapshot(longNames).roots)).toContain("Long names");
      await otherTab();

      // A 40 MB console message is dropped; diagnostics and every tab carry on.
      const logged = await driver.openTarget(`${base}/log`);
      await driver.debug(logged.target.id);
      expect(names(snapshot(await driver.observe(logged.target.id)).roots)).toContain("Logged");
      await otherTab();
    } finally {
      await driver.close();
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  },
  180_000,
);
