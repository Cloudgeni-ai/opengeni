import { createHash } from "node:crypto";

let buffer = Buffer.alloc(0);

process.stdin.on("data", (chunk: Buffer) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (buffer.byteLength >= 4) {
    const length = buffer.readUInt32BE(0);
    if (buffer.byteLength < 4 + length) return;
    const request = JSON.parse(buffer.subarray(4, 4 + length).toString("utf8")) as {
      requestId: string;
      method: string;
      targetId?: string;
    };
    buffer = buffer.subarray(4 + length);
    void handle(request);
  }
});

async function handle(request: {
  requestId: string;
  method: string;
  targetId?: string;
}): Promise<void> {
  if (request.method === "targets") await new Promise((resolve) => setTimeout(resolve, 20));
  if (request.method === "observe" && request.targetId === "missing") {
    write({
      protocolVersion: 2,
      requestId: request.requestId,
      status: "error",
      error: {
        code: "target_not_found",
        message: "fixture target is missing",
        retryable: false,
        dispatched: false,
      },
    });
    return;
  }
  if (request.method === "observe" && request.targetId === "malformed") {
    write({
      protocolVersion: 2,
      requestId: request.requestId,
      status: "ok",
      result: { invalid: true },
    });
    return;
  }
  if (request.method === "capture") {
    const attachment = Buffer.from("fixture-png");
    const response = {
      protocolVersion: 2,
      requestId: request.requestId,
      status: "ok",
      result: {
        frameId: "frame-1",
        targetId: request.targetId,
        targetGeneration: "target-generation-1",
        width: 10,
        height: 20,
        mimeType: "image/png",
        sha256: createHash("sha256").update(attachment).digest("hex"),
        attachmentBytes: attachment.byteLength,
      },
    };
    write(response, request.targetId === "stalled" ? undefined : attachment);
    return;
  }
  write({
    protocolVersion: 2,
    requestId: request.requestId,
    status: "ok",
    result: result(request.method),
  });
}

function result(method: string): unknown {
  if (method === "handshake") {
    return {
      protocolVersion: 2,
      helperVersion: "fixture-1",
      platform: "linux",
      capabilities: capabilities(),
    };
  }
  if (method === "capabilities") return capabilities();
  if (method === "targets") return [target()];
  if (method === "clipboard") return { text: "fixture clipboard", truncated: false };
  if (method === "validate") return null;
  if (method === "observe" || method === "dispatch") {
    return {
      observationId: "observation-1",
      target: target(),
      frameId: "frame-1",
      roots: [],
      nodeCount: 0,
      focusedRef: null,
      changedRegions: [],
    };
  }
  throw new Error(`unsupported fixture method ${method}`);
}

function capabilities() {
  return {
    semanticObservation: true,
    appDiscovery: true,
    appLaunch: true,
    windowCapture: true,
    screenCapture: true,
    semanticActions: true,
    pointerInput: true,
    keyboardInput: true,
    clipboard: true,
    backgroundActions: true,
    parallelApps: true,
  };
}

function target() {
  return {
    id: "window-1",
    targetGeneration: "target-generation-1",
    kind: "window",
    applicationId: "fixture.desktop",
    processId: 42,
    title: "Fixture",
    bounds: { x: 1, y: 2, width: 300, height: 200 },
    focused: true,
  };
}

function write(response: unknown, attachment?: Buffer): void {
  const json = Buffer.from(JSON.stringify(response), "utf8");
  const frames = [frame(json), ...(attachment ? [frame(attachment)] : [])];
  process.stdout.write(Buffer.concat(frames));
}

function frame(payload: Buffer): Buffer {
  const output = Buffer.allocUnsafe(4 + payload.byteLength);
  output.writeUInt32BE(payload.byteLength, 0);
  payload.copy(output, 4);
  return output;
}
