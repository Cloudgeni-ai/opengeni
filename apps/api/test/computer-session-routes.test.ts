import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";

const routeUrl = new URL("../src/routes/computer-sessions.ts", import.meta.url);
const appUrl = new URL("../src/app.ts", import.meta.url);

describe("ComputerSession route discipline", () => {
  test("registers the complete truthful lifecycle, control, receipt, and frame surface", async () => {
    const source = await readFile(routeUrl, "utf8");
    for (const route of [
      '"/v1/workspaces/:workspaceId/computer-sessions"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/targets"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/targets/:targetId/observation"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/clipboard"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/actions"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/operations/:operationId"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/attachments"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/heartbeat"',
      '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/end"',
    ]) {
      expect(source).toContain(route);
    }
    expect(source).not.toContain("/computer-sessions/:computerSessionId/suspend");
    expect(source).not.toContain("/computer-sessions/:computerSessionId/resume");
    expect(source).toContain('kind: "direct_websocket"');
    expect(source).toContain('kind: "direct_rfb"');
    expect(source).toContain('kind: "relay"');
    expect(source).toContain("openRelayedComputerFrameStream");
    expect(source).toContain("COMPUTER_CONTROL_WEBSOCKET_PROTOCOL");
    const attachment = source.slice(
      source.indexOf(
        '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/attachments"',
      ),
      source.indexOf(
        '"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/heartbeat"',
      ),
    );
    expect(attachment).toContain("requestOrigin(context, deps.settings)");
    expect(attachment).toContain("client.addAllowedOrigins([origin])");
    expect(attachment).toContain("sessionClient.listTargets()");
    expect(attachment).toContain('target.kind === "screen"');
    expect(attachment).toContain('record.session.platform === "linux"');
    expect(attachment).toContain("client.computerRfbStreamUrl");
    expect(attachment).toContain("COMPUTER_RFB_WEBSOCKET_PROTOCOL");
    expect(attachment).toContain("placementUsesInteractionFrameProxy(placement.lease?.backend)");
    expect(attachment).toContain("createInteractionFrameProxyAttachment");
    expect(await readFile(appUrl, "utf8")).toContain(
      "registerComputerSessionRoutes(app, routeDeps)",
    );
  });

  test("authenticates before parsing and derives physical facts only from controller output", async () => {
    const source = await readFile(routeUrl, "utf8");
    const start = source.indexOf('app.post("/v1/workspaces/:workspaceId/computer-sessions"');
    const end = source.indexOf("app.get(", start);
    const create = source.slice(start, end);
    expect(create.indexOf("requireAccessGrant")).toBeGreaterThanOrEqual(0);
    expect(create.indexOf("requireAccessGrant")).toBeLessThan(
      create.indexOf("parseJsonBody(context, CreateComputerSessionRequest)"),
    );
    expect(create.indexOf("createComputerSession")).toBeLessThan(
      create.indexOf("activateComputerSession"),
    );
    for (const field of [
      "physical.platform",
      "physical.adapter",
      "physical.seatId",
      "physical.displayId",
      "physical.capabilities",
    ]) {
      expect(create).toContain(field);
    }
  });

  test("admits every active operation through the exact durable controller and lease fence", async () => {
    const source = await readFile(routeUrl, "utf8");
    const active = source.slice(source.indexOf("async function withActiveComputerController"));
    expect(active.indexOf("touchComputerSessionController(deps.db")).toBeLessThan(
      active.indexOf("return await withComputerPlacement("),
    );
    expect(source).toContain("holderId: interactionHolderId(computerSessionId)");
    expect(source).toContain("return `computer-session:${computerSessionId}`");
    expect(source).toContain("expectedPlacementInstanceId");
  });

  test("routes attached-device ComputerSessions through the exact connected agent fence", async () => {
    const source = await readFile(routeUrl, "utf8");
    const placement = source.slice(
      source.indexOf("async function withComputerPlacement"),
      source.indexOf("async function withActiveComputerController"),
    );
    expect(placement).toContain('expectedPlacement?.kind === "attached_device"');
    expect(placement).toContain("getAttachedBrowserDevice(deps.db");
    expect(placement).toContain("getLiveEnrollmentConnection(");
    expect(placement).toContain("enrollment.connectionInstanceId");
    expect(placement).toContain("buildSelfhostedBackendSession({");
    expect(placement).toContain("new NatsControlRpc(");
    expect(placement).toContain("attachedEndPlacementInstanceId(");
    expect(placement).toContain("device.connectionGeneration");
    expect(source).toContain('operation === "computer.end" && expectedPlacementInstanceId');
  });

  test("dispatches lifecycle authority before physical mutation and preserves unknown outcomes", async () => {
    const source = await readFile(routeUrl, "utf8");
    const create = source.slice(
      source.indexOf('app.post("/v1/workspaces/:workspaceId/computer-sessions"'),
      source.indexOf(
        "app.get(",
        source.indexOf('app.post("/v1/workspaces/:workspaceId/computer-sessions"'),
      ),
    );
    expect(create.indexOf("ensureDispatchedGeneration")).toBeLessThan(
      create.indexOf("client.createComputerSession"),
    );
    expect(create).toContain('state: "outcome_unknown" as const');
    expect(create).toContain("const rethrowAfterFailure =");
    expect(create).toContain("error instanceof BrowserControlTransportError");
    expect(create).toContain("isAbort(error)");
    expect(create.indexOf("failComputerSessionOperation")).toBeLessThan(
      create.indexOf("if (rethrowAfterFailure) throw error"),
    );

    const end = source.slice(
      source.indexOf('"/v1/workspaces/:workspaceId/computer-sessions/:computerSessionId/end"'),
      source.indexOf("async function withComputerPlacement"),
    );
    const dispatched = end.slice(end.indexOf("dispatchComputerSessionOperation"));
    expect(dispatched.indexOf("dispatchComputerSessionOperation")).toBeLessThan(
      dispatched.indexOf("client.endComputerSession"),
    );
    expect(dispatched.indexOf("client.endComputerSession")).toBeLessThan(
      dispatched.indexOf("completeComputerSessionEnd"),
    );
  });
});
