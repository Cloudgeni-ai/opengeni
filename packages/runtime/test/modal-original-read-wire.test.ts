import { afterEach, expect, spyOn, test } from "bun:test";
import { Client, Server, ServerCredentials, status, type ServiceDefinition } from "@grpc/grpc-js";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import protobuf from "protobufjs";
import * as t from "oxc-parser";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ModalOriginalReadWire,
  modalOriginalReadSchema,
  type ModalOriginalReadSnapshot,
} from "../src/sandbox/providers/modal-original-read-wire";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const run of cleanup.splice(0).reverse()) await run();
});

const definition = (method: string, input: string, output: string) => ({
  path: `/modal.client.ModalClient/${method}`,
  requestStream: false,
  responseStream: false,
  requestSerialize: (value: object) =>
    Buffer.from(modalOriginalReadSchema.lookupType(input).encode(value).finish()),
  requestDeserialize: (bytes: Buffer) => modalOriginalReadSchema.lookupType(input).decode(bytes),
  responseSerialize: (value: object) =>
    Buffer.from(modalOriginalReadSchema.lookupType(output).encode(value).finish()),
  responseDeserialize: (bytes: Buffer) => modalOriginalReadSchema.lookupType(output).decode(bytes),
});

async function fixture(options: { usernameOnly?: boolean; rejectLookup?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), "modal-original-read-tls-"));
  const key = join(directory, "key.pem"),
    cert = join(directory, "cert.pem");
  const generated = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-addext",
      "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ],
    { stdio: "pipe" },
  );
  if (generated.status !== 0) throw new Error("Test TLS certificate generation failed");
  const server = new Server();
  const calls: string[] = [];
  const check = (call: any, method: string) => {
    calls.push(method);
    expect(call.metadata.get("x-modal-token-id")).toEqual(["original-id"]);
    expect(call.metadata.get("x-modal-token-secret")).toEqual(["original-secret"]);
    expect(call.metadata.get("x-modal-client-type")).toEqual(["8"]);
    expect(call.metadata.get("x-modal-client-version")).toEqual(["1.0.0"]);
    expect(call.metadata.get("x-modal-libmodal-version")).toEqual(["modal-js/0.9.0"]);
    expect(call.metadata.get("x-modal-auth-token")).toEqual(
      method === "auth" ? [] : ["original-auth-token"],
    );
  };
  server.addService(
    {
      auth: definition("AuthTokenGet", "Empty", "AuthToken"),
      namespace: definition("WorkspaceNameLookup", "Empty", "Namespace"),
      access: definition("TaskGetCommandRouterAccess", "Task", "RouterAccess"),
      // Negative controls: the private wire must never call these methods.
      create: definition("SandboxCreate", "Empty", "Empty"),
      taskGet: definition("TaskGet", "Empty", "Empty"),
    } as ServiceDefinition,
    {
      auth(call: any, callback: any) {
        check(call, "auth");
        callback(null, { token: "original-auth-token" });
      },
      namespace(call: any, callback: any) {
        check(call, "namespace");
        if (options.rejectLookup) {
          callback({
            code: status.UNAVAILABLE,
            details: "private original-secret provider failure",
          });
          return;
        }
        callback(
          null,
          options.usernameOnly
            ? { username: "original-username" }
            : { workspaceName: "original-workspace", username: "not-the-selected-field" },
        );
      },
      access(call: any, callback: any) {
        check(call, "access");
        expect(call.request.taskId).toBe("task-original");
        callback(null, { url: "https://router.example.test", jwt: "ephemeral-router-token" });
      },
      create(_call: any, callback: any) {
        calls.push("create");
        callback(null, {});
      },
      taskGet(_call: any, callback: any) {
        calls.push("taskGet");
        callback(null, {});
      },
    },
  );
  const port = await new Promise<number>((resolve, reject) =>
    server.bindAsync(
      "127.0.0.1:0",
      ServerCredentials.createSsl(null, [
        { private_key: readFileSync(key), cert_chain: readFileSync(cert) },
      ]),
      (error, value) => (error ? reject(error) : resolve(value)),
    ),
  );
  const snapshot: ModalOriginalReadSnapshot = {
    serverUrl: `https://localhost:${port}`,
    tokenId: "original-id",
    tokenSecret: "original-secret",
    environment: "",
  };
  const wire = new ModalOriginalReadWire(snapshot, readFileSync(cert));
  cleanup.push(async () => {
    await wire.close();
    server.forceShutdown();
    rmSync(directory, { recursive: true, force: true });
  });
  return { directory, cert, snapshot, wire, calls };
}

test("real TLS sends the exact explicit pair, honest namespace field and original task with no mutation", async () => {
  const f = await fixture();
  expect(await f.wire.readNamespace()).toEqual({
    responseField: "workspaceName",
    value: "original-workspace",
  });
  expect(await f.wire.readRouterAccess("task-original")).toEqual({
    url: "https://router.example.test",
    jwt: "ephemeral-router-token",
  });
  expect(f.calls).toEqual(["auth", "namespace", "auth", "access"]);
  expect(f.wire.pendingObservations).toBe(0);
  expect(JSON.stringify(f.wire)).toBe("{}");
  await f.wire.close();
  await expect(f.wire.readNamespace()).rejects.toThrow("Invalid or unavailable");
  expect(f.calls).toHaveLength(4);
});

test("username-only response retains its actual source field, not a made-up principal", async () => {
  const f = await fixture({ usernameOnly: true });
  expect(await f.wire.readNamespace()).toEqual({
    responseField: "username",
    value: "original-username",
  });
});

test("caller snapshot mutation cannot change the sampled pair or endpoint", async () => {
  const f = await fixture();
  Object.assign(f.snapshot, {
    tokenId: "replacement-id",
    tokenSecret: "replacement-secret",
    serverUrl: "https://invalid.example.test",
    environment: "replacement-env",
  });
  expect(await f.wire.readNamespace()).toEqual({
    responseField: "workspaceName",
    value: "original-workspace",
  });
  expect(f.calls).toEqual(["auth", "namespace"]);
});

test("provider failure is generic and is never retried or promoted to physical loss", async () => {
  const f = await fixture({ rejectLookup: true });
  const error = await f.wire.readNamespace().catch((failure: Error) => failure);
  expect(error).toBeInstanceOf(Error);
  expect((error as Error).message).toBe("Invalid or unavailable Modal original read transport");
  expect((error as Error).cause).toBeUndefined();
  expect(JSON.stringify(error)).not.toContain("original-secret");
  expect(f.calls).toEqual(["auth", "namespace"]);
});

test("constructor rejects missing/ambient fields, unsafe endpoints and traps without invoking getters", () => {
  const valid = {
    serverUrl: "https://api.modal.com:443",
    tokenId: "id",
    tokenSecret: "secret",
    environment: "",
  };
  for (const input of [
    { ...valid, tokenId: "" },
    { ...valid, tokenSecret: "" },
    { ...valid, serverUrl: "http://api.modal.com" },
    { ...valid, serverUrl: "https://user:password@api.modal.com" },
    { ...valid, serverUrl: "https://api.modal.com/path" },
    { ...valid, serverUrl: "https://api.modal.com?secret=value" },
    { ...valid, cpClient: {} },
    { ...valid, environment: undefined },
  ])
    expect(() => new ModalOriginalReadWire(input as never)).toThrow("Invalid or unavailable");
  let traps = 0;
  expect(
    () =>
      new ModalOriginalReadWire(
        new Proxy(valid, {
          ownKeys() {
            traps++;
            return [];
          },
        }),
      ),
  ).toThrow();
  const getter = Object.defineProperty({ ...valid }, "tokenSecret", {
    get() {
      traps++;
      return "secret";
    },
  });
  expect(() => new ModalOriginalReadWire(getter)).toThrow();
  expect(traps).toBe(0);
});

test("abort before admission causes zero native calls", async () => {
  const f = await fixture();
  const signal = AbortSignal.abort();
  await expect(f.wire.readNamespace(signal)).rejects.toThrow();
  await expect(f.wire.readRouterAccess("task-original", signal)).rejects.toThrow();
  expect(f.calls).toHaveLength(0);
});

test("abort-ignoring native callback keeps the slot and joined close held until actual settlement", async () => {
  let callback: ((error: Error | null, response?: unknown) => void) | undefined;
  let cancellations = 0;
  let calls = 0;
  const mock = spyOn(Client.prototype, "makeUnaryRequest").mockImplementation((...args: any[]) => {
    calls++;
    callback = args.at(-1);
    return {
      cancel() {
        cancellations++;
      },
    } as never;
  });
  const wire = new ModalOriginalReadWire({
    serverUrl: "https://api.modal.com",
    tokenId: "fake-id",
    tokenSecret: "fake-secret",
    environment: "",
  });
  try {
    const controller = new AbortController();
    const result = wire.readNamespace(controller.signal).then(
      () => "accepted",
      () => "rejected",
    );
    expect(wire.pendingObservations).toBe(1);
    controller.abort();
    expect(cancellations).toBe(1);
    await expect(wire.readNamespace()).rejects.toThrow();
    let closed = false;
    const closing = wire.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(wire.pendingObservations).toBe(1);
    expect(calls).toBe(1);
    callback!(
      null,
      modalOriginalReadSchema.lookupType("AuthToken").create({ token: "late-token" }),
    );
    expect(await result).toBe("rejected");
    await closing;
    expect(closed).toBe(true);
    expect(wire.pendingObservations).toBe(0);
    expect(calls).toBe(1); // A late auth result cannot begin namespace lookup.
  } finally {
    mock.mockRestore();
    await wire.close();
  }
});

test("a late native namespace response after abort still joins without manufacturing a binding result", async () => {
  let namespaceCallback: ((error: Error | null, response?: unknown) => void) | undefined;
  let namespaceEntered!: () => void;
  const entered = new Promise<void>((resolve) => {
    namespaceEntered = resolve;
  });
  const calls: string[] = [];
  const mock = spyOn(Client.prototype, "makeUnaryRequest").mockImplementation((...args: any[]) => {
    calls.push(args[0]);
    const callback = args.at(-1);
    if (args[0].endsWith("/AuthTokenGet"))
      queueMicrotask(() =>
        callback(null, modalOriginalReadSchema.lookupType("AuthToken").create({ token: "token" })),
      );
    else {
      namespaceCallback = callback;
      namespaceEntered();
    }
    return { cancel() {} } as never;
  });
  const wire = new ModalOriginalReadWire({
    serverUrl: "https://api.modal.com",
    tokenId: "fake-id",
    tokenSecret: "fake-secret",
    environment: "",
  });
  try {
    const controller = new AbortController();
    const result = wire.readNamespace(controller.signal).then(
      () => "accepted",
      () => "rejected",
    );
    // Observe the actual namespace phase, not merely an accepted scheduling DTO.
    await entered;
    expect(namespaceCallback).toBeDefined();
    controller.abort();
    let closed = false;
    const closing = wire.close().then(() => {
      closed = true;
    });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(wire.pendingObservations).toBe(1);
    await expect(wire.readNamespace()).rejects.toThrow();
    namespaceCallback!(
      null,
      modalOriginalReadSchema.lookupType("Namespace").create({ workspaceName: "late-workspace" }),
    );
    expect(await result).toBe("rejected");
    await closing;
    expect(wire.pendingObservations).toBe(0);
    expect(calls).toEqual([
      "/modal.client.ModalClient/AuthTokenGet",
      "/modal.client.ModalClient/WorkspaceNameLookup",
    ]);
  } finally {
    mock.mockRestore();
    await wire.close();
  }
});

test("synchronous native errors also stay generic, without private details or causes", async () => {
  const mock = spyOn(Client.prototype, "makeUnaryRequest").mockImplementation(() => {
    throw new Error("fake-secret private native failure", { cause: "private cause" });
  });
  const wire = new ModalOriginalReadWire({
    serverUrl: "https://api.modal.com",
    tokenId: "fake-id",
    tokenSecret: "fake-secret",
    environment: "",
  });
  try {
    const failure = await wire.readNamespace().catch((error: Error) => error);
    expect((failure as Error).message).toBe("Invalid or unavailable Modal original read transport");
    expect((failure as Error).cause).toBeUndefined();
    expect(wire.pendingObservations).toBe(0);
  } finally {
    mock.mockRestore();
    await wire.close();
  }
});

test("isolated ambient profile/pair/endpoint values cannot replace the explicit TLS snapshot", async () => {
  const f = await fixture();
  const config = join(f.directory, "modal.toml");
  writeFileSync(
    config,
    '[ambient]\nactive = true\nserver_url = "https://invalid.example.test"\ntoken_id = "ambient-id"\ntoken_secret = "ambient-secret"\nenvironment = "ambient-env"\n',
  );
  const path = new URL("../src/sandbox/providers/modal-original-read-wire.ts", import.meta.url)
    .href;
  const code = `import {readFileSync} from 'node:fs'; import {ModalOriginalReadWire} from ${JSON.stringify(path)};
    const wire = new ModalOriginalReadWire(${JSON.stringify(f.snapshot)}, readFileSync(${JSON.stringify(f.cert)}));
    try { console.log(JSON.stringify(await wire.readNamespace())); } finally { await wire.close(); }`;
  const child = spawn(process.execPath, ["--no-env-file", "-e", code], {
    env: {
      PATH: process.env.PATH,
      MODAL_CONFIG_PATH: config,
      MODAL_PROFILE: "ambient",
      MODAL_SERVER_URL: "https://invalid.example.test",
      MODAL_TOKEN_ID: "ambient-id",
      MODAL_TOKEN_SECRET: "ambient-secret",
      MODAL_ENVIRONMENT: "ambient-env",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "",
    errors = "";
  child.stdout.on("data", (bytes) => {
    output += bytes;
  });
  child.stderr.on("data", (bytes) => {
    errors += bytes;
  });
  const codeResult = await new Promise<number | null>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  expect(codeResult).toBe(0);
  expect(errors).toBe("");
  expect(JSON.parse(output)).toEqual({
    responseField: "workspaceName",
    value: "original-workspace",
  });
  expect(f.calls).toEqual(["auth", "namespace"]);
}, 10_000);

// Inspect only the generated read descriptors/codecs. Do not construct an SDK
// client, read ambient configuration, or execute the rest of the SDK bundle.
function installedReadProjection(source: string) {
  const parsed = t.parseSync("modal.js", source);
  if (parsed.errors.length) throw new Error("Invalid generated SDK source");
  const declarations = parsed.program.body.flatMap((statement) =>
    statement.type === "VariableDeclaration" ? statement.declarations : [],
  );
  const object = (name: string) => {
    const initializer = declarations.find(
      (item) => item.id.type === "Identifier" && item.id.name === name,
    )?.init;
    if (!initializer || initializer.type !== "ObjectExpression")
      throw new Error(`Missing generated SDK object ${name}`);
    return initializer;
  };
  const property = (value: t.ObjectExpression, name: string) => {
    const member = value.properties.find(
      (item) =>
        item.type === "Property" && item.key.type === "Identifier" && item.key.name === name,
    );
    if (!member || member.type !== "Property")
      throw new Error(`Missing generated SDK property ${name}`);
    return member;
  };
  const clientDefinition = object("ModalClientDefinition");
  const methods = property(clientDefinition, "methods").value;
  if (methods.type !== "ObjectExpression") throw new Error("Missing SDK methods");
  const codec = (name: string) => {
    const value = object(name);
    const codecMethods = ["encode", "decode"].map((method) => {
      const member = property(value, method);
      if (!member.method || member.value.type !== "FunctionExpression")
        throw new Error(`Missing SDK codec ${method}`);
      return source.slice(member.start, member.end);
    });
    const base = parsed.program.body.find(
      (item) => item.type === "FunctionDeclaration" && item.id?.name === `createBase${name}`,
    );
    if (!base) throw new Error(`Missing SDK defaults ${name}`);
    return runInNewContext(`${source.slice(base.start, base.end)}; ({${codecMethods.join(",")}})`, {
      BinaryReader: protobuf.Reader,
      BinaryWriter: protobuf.Writer,
    }) as {
      encode(input: object): protobuf.Writer;
      decode(input: Uint8Array): object;
    };
  };
  return {
    codec,
    method(name: string) {
      const value = property(methods, name).value;
      if (value.type !== "ObjectExpression") throw new Error(`Missing SDK RPC ${name}`);
      return Object.fromEntries(
        ["name", "requestType", "requestStream", "responseType", "responseStream"].map((key) => {
          const item = property(value, key).value;
          return [key, item.type === "Literal" ? item.value : source.slice(item.start, item.end)];
        }),
      );
    },
    fullName: property(clientDefinition, "fullName").value,
  };
}

test("wire projection matches installed Modal 0.9.0 read RPCs and exact field bytes", () => {
  const require = createRequire(import.meta.resolve("modal"));
  expect(require("modal/package.json").version).toBe("0.9.0");
  const source = readFileSync(new URL(import.meta.resolve("modal")), "utf8");
  // Command-router transport patches may change bundle bytes without changing
  // these read RPCs. Guard the actual generated schema, not unrelated code.
  const sdk = installedReadProjection(source);
  expect(sdk.fullName).toMatchObject({ type: "Literal", value: "modal.client.ModalClient" });
  for (const [method, name, requestType, responseType] of [
    ["authTokenGet", "AuthTokenGet", "AuthTokenGetRequest", "AuthTokenGetResponse"],
    ["workspaceNameLookup", "WorkspaceNameLookup", "Empty", "WorkspaceNameLookupResponse"],
    [
      "taskGetCommandRouterAccess",
      "TaskGetCommandRouterAccess",
      "TaskGetCommandRouterAccessRequest",
      "TaskGetCommandRouterAccessResponse",
    ],
  ])
    expect(sdk.method(method!)).toEqual({
      name,
      requestType,
      responseType,
      requestStream: false,
      responseStream: false,
    });
  const samples = [
    ["Empty", "AuthTokenGetRequest", {}, ""],
    ["Empty", "Empty", {}, ""],
    ["AuthToken", "AuthTokenGetResponse", { token: "t" }, "0a0174"],
    [
      "Namespace",
      "WorkspaceNameLookupResponse",
      { workspaceName: "w", username: "u" },
      "0a0177120175",
    ],
    ["Task", "TaskGetCommandRouterAccessRequest", { taskId: "t" }, "0a0174"],
    ["RouterAccess", "TaskGetCommandRouterAccessResponse", { jwt: "j", url: "u" }, "0a016a120175"],
  ] as const;
  for (const [name, generated, input, hex] of samples) {
    const type = modalOriginalReadSchema.lookupType(name);
    expect(Buffer.from(type.encode(type.fromObject(input)).finish()).toString("hex")).toBe(hex);
    expect(type.toObject(type.decode(Buffer.from(hex, "hex")))).toEqual(input);
    const codec = sdk.codec(generated);
    expect(Buffer.from(codec.encode(input).finish()).toString("hex")).toBe(hex);
    expect(codec.decode(Buffer.from(hex, "hex"))).toEqual(input);
  }
  // Generated decoding supplies empty defaults; the narrow projection keeps
  // absent fields absent so username-only output retains honest provenance.
  const usernameOnly = Buffer.from("120175", "hex");
  expect(sdk.codec("WorkspaceNameLookupResponse").decode(usernameOnly)).toEqual({
    workspaceName: "",
    username: "u",
  });
  expect(
    modalOriginalReadSchema
      .lookupType("Namespace")
      .toObject(modalOriginalReadSchema.lookupType("Namespace").decode(usernameOnly)),
  ).toEqual({ username: "u" });
  // A token on a different field must not become authenticated read output.
  expect(sdk.codec("AuthTokenGetResponse").decode(Buffer.from("1a0174", "hex"))).toEqual({
    token: "",
  });
  expect(
    modalOriginalReadSchema
      .lookupType("AuthToken")
      .toObject(
        modalOriginalReadSchema.lookupType("AuthToken").decode(Buffer.from("1a0174", "hex")),
      ),
  ).toEqual({});
});
