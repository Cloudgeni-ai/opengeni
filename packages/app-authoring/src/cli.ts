import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative, resolve, sep } from "node:path";

import {
  AppBuildCheckReceipt as AppBuildCheckReceiptSchema,
  type AppBuildCheckReceipt,
  type AppSignedUpload,
} from "@opengeni/contracts/apps";
import { OpenGeniAppsClient } from "@opengeni/sdk/apps";

import { createOgAppAuthoringHttpTransport } from "./control-transport";
import {
  createAppBuildManifest,
  createOgAppSourceManifest,
  createPortableAppArchive,
  encodeOgAppSourceManifest,
  inspectPortableAppArchive,
  normalizePortableAppPath,
  sha256Hex,
  validatePortableAppEntries,
  type PortableAppArchiveEntry,
} from "./index";

export type OgAppCliIo = {
  cwd: string;
  env?: Readonly<Record<string, string | undefined>>;
  stdout(message: string): void;
  stderr(message: string): void;
};

type AppsDeployClient = Pick<
  OpenGeniAppsClient,
  | "listApps"
  | "getApp"
  | "createApp"
  | "getAvailableRuntimeCatalog"
  | "createToolPolicy"
  | "beginSourceUpload"
  | "completeSourceUpload"
  | "prepareBuild"
  | "listBuildUploads"
  | "completeBuild"
  | "promoteBuild"
  | "createPreview"
  | "publish"
>;

export type OgAppCliDependencies = Readonly<{
  createAppsClient?: (input: {
    baseUrl: string;
    apiKey?: string;
    sessionCookie?: string;
  }) => AppsDeployClient;
  putSignedUpload?: (upload: AppSignedUpload, bytes: Uint8Array) => Promise<void>;
  runCheck?: (
    kind: AppBuildCheckReceipt["kind"],
    command: string,
    cwd: string,
  ) => AppBuildCheckReceipt;
  randomUuid?: () => string;
}>;

const DEFAULT_IO: OgAppCliIo = {
  cwd: process.cwd(),
  env: process.env,
  stdout: (message) => process.stdout.write(message),
  stderr: (message) => process.stderr.write(message),
};

function usage(): string {
  return [
    "usage:",
    '  og-app init [directory] --name "My app" [--slug my-app]',
    "  og-app validate <directory-or-archive>",
    "  og-app pack <directory> [--output app.ogapp.tar]",
    "  og-app deploy <directory> --workspace <id> [--base-url <origin>] [--app-id <id>]",
    "    --typecheck-command <command> --test-command <command> --build-command <command>",
    "    [--allow-tool <serverId/toolName>]... [--preview] [--publish]",
    "    [--reason <text>] [--deployment-id <uuid>] [--state <path>]",
    "  og-app --help",
  ].join("\n");
}

function option(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
  return value;
}

function positional(args: string[]): string[] {
  const booleanOptions = new Set(["--preview", "--publish"]);
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index]!;
    if (value.startsWith("--")) {
      if (!booleanOptions.has(value)) index += 1;
      continue;
    }
    values.push(value);
  }
  return values;
}

function options(args: string[], name: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] !== name) continue;
    const value = args[index + 1];
    if (!value || value.startsWith("--")) throw new Error(`${name} requires a value.`);
    values.push(value);
    index += 1;
  }
  return values;
}

async function collectDirectory(
  root: string,
  excludedAbsolutePath?: string,
): Promise<PortableAppArchiveEntry[]> {
  const entries: PortableAppArchiveEntry[] = [];
  async function visit(directory: string): Promise<void> {
    const children = await readdir(directory, { withFileTypes: true });
    children.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
    for (const child of children) {
      if (child.name === ".git" || child.name === ".opengeni" || child.name === "node_modules") {
        continue;
      }
      const absolute = join(directory, child.name);
      if (excludedAbsolutePath && resolve(absolute) === excludedAbsolutePath) continue;
      if (child.isSymbolicLink())
        throw new Error(`App source may not contain symlink ${absolute}.`);
      if (child.isDirectory()) {
        await visit(absolute);
        continue;
      }
      if (!child.isFile())
        throw new Error(`App source may contain regular files only: ${absolute}.`);
      const info = await lstat(absolute);
      if (!info.isFile()) throw new Error(`App source changed while reading ${absolute}.`);
      const path = normalizePortableAppPath(relative(root, absolute).split(sep).join("/"));
      entries.push({
        path,
        bytes: new Uint8Array(await readFile(absolute)),
        ...((info.mode & 0o111) !== 0 ? { executable: true } : {}),
      });
    }
  }
  await visit(root);
  return entries;
}

async function initialize(args: string[], io: OgAppCliIo): Promise<number> {
  const directory = resolve(io.cwd, positional(args)[0] ?? ".");
  const name = option(args, "--name");
  if (!name) throw new Error("og-app init requires --name.");
  const slug = option(args, "--slug");
  const manifest = createOgAppSourceManifest({
    name,
    ...(slug === undefined ? {} : { slug }),
  });
  await mkdir(directory, { recursive: true });
  const manifestPath = join(directory, "og-app.json");
  const entryPath = join(directory, manifest.entryPath);
  await writeFile(manifestPath, encodeOgAppSourceManifest(manifest), {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    entryPath,
    `<!doctype html>\n<html lang="en">\n<head>\n  <meta charset="utf-8">\n  <meta name="viewport" content="width=device-width, initial-scale=1">\n  <title>${manifest.name.replace(/[&<>"']/gu, "")}</title>\n</head>\n<body>\n  <main>\n    <h1>${manifest.name.replace(/[&<>"']/gu, "")}</h1>\n    <p>Your OpenGeni App is ready to build.</p>\n  </main>\n</body>\n</html>\n`,
    { flag: "wx", mode: 0o600 },
  );
  io.stdout(`${JSON.stringify({ directory, manifest: manifestPath, entryPath }, null, 2)}\n`);
  return 0;
}

async function validate(target: string, io: OgAppCliIo): Promise<number> {
  const absolute = resolve(io.cwd, target);
  const info = await lstat(absolute);
  if (info.isSymbolicLink()) throw new Error("og-app validate refuses symlink targets.");
  const result = info.isDirectory()
    ? validatePortableAppEntries(await collectDirectory(absolute))
    : inspectPortableAppArchive(new Uint8Array(await readFile(absolute)));
  io.stdout(
    `${JSON.stringify(
      {
        valid: true,
        target: absolute,
        name: result.sourceManifest.name,
        slug: result.sourceManifest.slug,
        appVersion: result.sourceManifest.appVersion,
        entryPath: result.sourceManifest.entryPath,
        fileCount: result.entries.length,
        totalBytes: result.entries.reduce((total, entry) => total + entry.bytes.byteLength, 0),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

async function pack(args: string[], io: OgAppCliIo): Promise<number> {
  const directory = resolve(io.cwd, positional(args)[0] ?? ".");
  const requestedOutput = option(args, "--output");
  const output = resolve(io.cwd, requestedOutput ?? `${basename(directory)}.ogapp.tar`);
  const entries = await collectDirectory(directory, output);
  const { sourceManifest } = validatePortableAppEntries(entries);
  const archive = createPortableAppArchive(entries);
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, archive, { flag: "wx", mode: 0o600 });
  io.stdout(
    `${JSON.stringify(
      {
        output,
        format: "portable_tar_v1",
        app: sourceManifest.slug,
        appVersion: sourceManifest.appVersion,
        sizeBytes: archive.byteLength,
        sha256: sha256Hex(archive),
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

type OgAppDeployState = {
  schemaVersion: 1;
  deploymentId: string;
  baseUrl: string;
  workspaceId: string;
  sourceSha256: string;
  sourceSizeBytes: number;
  checkCommands: Record<AppBuildCheckReceipt["kind"], string>;
  checks: AppBuildCheckReceipt[];
  allowedToolSelectors: string[];
  appId?: string;
  policyExpectedVersion?: number;
  toolPolicyRevisionId?: string;
  sourceExpectedVersion?: number;
  sourceRevisionId?: string;
  sourceCompleted?: boolean;
  buildExpectedVersion?: number;
  buildId?: string;
  buildCompleted?: boolean;
  promoteExpectedVersion?: number;
  releaseId?: string;
  previewId?: string;
  publishExpectedVersion?: number;
  published?: boolean;
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const DEPLOY_STATE_KEYS = new Set<keyof OgAppDeployState>([
  "schemaVersion",
  "deploymentId",
  "baseUrl",
  "workspaceId",
  "sourceSha256",
  "sourceSizeBytes",
  "checkCommands",
  "checks",
  "allowedToolSelectors",
  "appId",
  "policyExpectedVersion",
  "toolPolicyRevisionId",
  "sourceExpectedVersion",
  "sourceRevisionId",
  "sourceCompleted",
  "buildExpectedVersion",
  "buildId",
  "buildCompleted",
  "promoteExpectedVersion",
  "releaseId",
  "previewId",
  "publishExpectedVersion",
  "published",
]);
const DEPLOY_STATE_UUID_KEYS = [
  "appId",
  "toolPolicyRevisionId",
  "sourceRevisionId",
  "buildId",
  "releaseId",
  "previewId",
] as const satisfies readonly (keyof OgAppDeployState)[];
const DEPLOY_STATE_VERSION_KEYS = [
  "policyExpectedVersion",
  "sourceExpectedVersion",
  "buildExpectedVersion",
  "promoteExpectedVersion",
  "publishExpectedVersion",
] as const satisfies readonly (keyof OgAppDeployState)[];
const DEPLOY_STATE_BOOLEAN_KEYS = [
  "sourceCompleted",
  "buildCompleted",
  "published",
] as const satisfies readonly (keyof OgAppDeployState)[];

function exactHttpOrigin(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be one HTTP(S) origin.`);
  }
  if (
    (url.protocol !== "https:" && url.protocol !== "http:") ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  ) {
    throw new Error(`${label} must be one HTTP(S) origin.`);
  }
  return url.origin;
}

function isExactHttpOrigin(value: string): boolean {
  try {
    return exactHttpOrigin(value, "origin") === value;
  } catch {
    return false;
  }
}

function requiredOptionOrEnv(
  args: string[],
  io: OgAppCliIo,
  optionName: string,
  environmentName: string,
): string {
  const value = option(args, optionName) ?? io.env?.[environmentName];
  if (!value?.trim()) throw new Error(`${optionName} or ${environmentName} is required.`);
  return value.trim();
}

function checkCommand(args: string[], name: string): string {
  const value = option(args, name);
  if (!value?.trim()) throw new Error(`og-app deploy requires ${name}.`);
  return value.trim();
}

function defaultRunCheck(
  kind: AppBuildCheckReceipt["kind"],
  command: string,
  cwd: string,
): AppBuildCheckReceipt {
  const startedAt = Date.now();
  const environment = { ...process.env };
  delete environment.OPENGENI_API_KEY;
  delete environment.OPENGENI_SESSION_COOKIE;
  const result = spawnSync(command, {
    cwd,
    shell: true,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
    env: environment,
  });
  const output = `stdout:\n${result.stdout ?? ""}\nstderr:\n${result.stderr ?? ""}`;
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `${kind} command failed with exit code ${result.status ?? "unknown"}: ${output.slice(-2_000)}`,
    );
  }
  return {
    kind,
    status: "succeeded",
    commandDigest: sha256Hex(new TextEncoder().encode(command)),
    outputDigest: sha256Hex(new TextEncoder().encode(output)),
    durationMs: Math.max(0, Date.now() - startedAt),
  };
}

async function defaultPutSignedUpload(upload: AppSignedUpload, bytes: Uint8Array): Promise<void> {
  const response = await fetch(upload.url, {
    method: upload.method,
    redirect: "error",
    credentials: "omit",
    headers: upload.headers,
    body: bytes as unknown as BodyInit,
  });
  if (!response.ok) {
    throw new Error(`Signed App upload failed with HTTP ${response.status}.`);
  }
}

function defaultCreateAppsClient(input: {
  baseUrl: string;
  apiKey?: string;
  sessionCookie?: string;
}): AppsDeployClient {
  if (Boolean(input.apiKey) === Boolean(input.sessionCookie)) {
    throw new Error(
      "Set exactly one of OPENGENI_API_KEY or OPENGENI_SESSION_COOKIE for og-app deploy.",
    );
  }
  return new OpenGeniAppsClient(
    createOgAppAuthoringHttpTransport({
      baseUrl: input.baseUrl,
      auth: input.apiKey
        ? { kind: "api_key", apiKey: input.apiKey }
        : { kind: "human_session", cookie: input.sessionCookie! },
    }),
  );
}

function stableOperationId(deploymentId: string, step: string): string {
  const bytes = createHash("sha256")
    .update(["opengeni-app-deploy-v1", deploymentId, step].join("\0"), "utf8")
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = bytes.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

async function readDeployState(path: string): Promise<OgAppDeployState | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (record(error)?.code === "ENOENT") return null;
    throw error;
  }
  const value = record(JSON.parse(text));
  const checkCommands = value ? record(value.checkCommands) : null;
  const checks = value && Array.isArray(value.checks) ? value.checks : null;
  const allowedToolSelectors = value?.allowedToolSelectors;
  if (
    !value ||
    Object.keys(value).some((key) => !DEPLOY_STATE_KEYS.has(key as keyof OgAppDeployState)) ||
    value.schemaVersion !== 1 ||
    typeof value.deploymentId !== "string" ||
    !UUID.test(value.deploymentId) ||
    typeof value.baseUrl !== "string" ||
    !isExactHttpOrigin(value.baseUrl) ||
    typeof value.workspaceId !== "string" ||
    !UUID.test(value.workspaceId) ||
    typeof value.sourceSha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sourceSha256) ||
    typeof value.sourceSizeBytes !== "number" ||
    !Number.isSafeInteger(value.sourceSizeBytes) ||
    value.sourceSizeBytes <= 0 ||
    !checkCommands ||
    Object.keys(checkCommands).length !== 3 ||
    [checkCommands.typecheck, checkCommands.test, checkCommands.build].some(
      (command) =>
        typeof command !== "string" || command.length === 0 || command.trim() !== command,
    ) ||
    !checks ||
    !Array.isArray(allowedToolSelectors) ||
    allowedToolSelectors.some(
      (selector) =>
        typeof selector !== "string" || selector.length === 0 || selector.trim() !== selector,
    ) ||
    new Set(allowedToolSelectors).size !== allowedToolSelectors.length ||
    DEPLOY_STATE_UUID_KEYS.some((key) => {
      const candidate = value[key];
      return candidate !== undefined && (typeof candidate !== "string" || !UUID.test(candidate));
    }) ||
    DEPLOY_STATE_VERSION_KEYS.some((key) => {
      const candidate = value[key];
      return (
        candidate !== undefined &&
        (typeof candidate !== "number" || !Number.isSafeInteger(candidate) || candidate <= 0)
      );
    }) ||
    DEPLOY_STATE_BOOLEAN_KEYS.some((key) => {
      const candidate = value[key];
      return candidate !== undefined && typeof candidate !== "boolean";
    }) ||
    (value.sourceCompleted === true && typeof value.sourceRevisionId !== "string") ||
    (value.buildCompleted === true && typeof value.buildId !== "string") ||
    (value.published === true && typeof value.releaseId !== "string")
  ) {
    throw new Error("The og-app deployment state file is invalid.");
  }
  let parsedChecks: AppBuildCheckReceipt[];
  try {
    parsedChecks = checks.map((check) => AppBuildCheckReceiptSchema.parse(check));
  } catch {
    throw new Error("The og-app deployment state file is invalid.");
  }
  if (
    parsedChecks.length !== 3 ||
    new Set(parsedChecks.map((check) => check.kind)).size !== 3 ||
    !["typecheck", "test", "build"].every((kind) =>
      parsedChecks.some((check) => check.kind === kind),
    )
  ) {
    throw new Error("The og-app deployment state file is invalid.");
  }
  return { ...(value as OgAppDeployState), checks: parsedChecks };
}

async function writeDeployState(path: string, state: OgAppDeployState): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, {
      flag: "wx",
      mode: 0o600,
    });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

function latestByRevision<T extends { revision: number }>(values: readonly T[]): T | null {
  return [...values].sort((left, right) => right.revision - left.revision)[0] ?? null;
}

async function findAppBySlug(client: AppsDeployClient, workspaceId: string, slug: string) {
  let cursor: string | undefined;
  for (let page = 0; page < 100; page += 1) {
    const result = await client.listApps(workspaceId, {
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    const app = result.apps.find((candidate) => candidate.slug === slug);
    if (app) return app;
    if (!result.nextCursor) return null;
    cursor = result.nextCursor;
  }
  throw new Error("Apps list pagination exceeded 100 pages.");
}

function selectedToolIdentities(
  selectors: readonly string[],
  tools: readonly { identity: { serverId: string; toolName: string } }[],
) {
  const available = new Map(
    tools.map((tool) => [`${tool.identity.serverId}/${tool.identity.toolName}`, tool.identity]),
  );
  return selectors.map((selector) => {
    const identity = available.get(selector);
    if (!identity) throw new Error(`Requested App tool is unavailable: ${selector}.`);
    return identity;
  });
}

async function deploy(
  args: string[],
  io: OgAppCliIo,
  dependencies: OgAppCliDependencies,
): Promise<number> {
  const directory = resolve(io.cwd, positional(args)[0] ?? ".");
  const workspaceId = requiredOptionOrEnv(args, io, "--workspace", "OPENGENI_WORKSPACE_ID");
  if (!UUID.test(workspaceId)) throw new Error("--workspace must be a UUID.");
  const baseUrl = exactHttpOrigin(
    requiredOptionOrEnv(args, io, "--base-url", "OPENGENI_BASE_URL"),
    "--base-url",
  );
  const requestedAppId = option(args, "--app-id");
  if (requestedAppId && !UUID.test(requestedAppId)) {
    throw new Error("--app-id must be a UUID.");
  }
  const requestedDeploymentId = option(args, "--deployment-id");
  const deploymentId = requestedDeploymentId ?? (dependencies.randomUuid ?? randomUUID)();
  if (!UUID.test(deploymentId)) throw new Error("--deployment-id must be a UUID.");
  const statePath = resolve(
    io.cwd,
    option(args, "--state") ?? `.opengeni/deployments/${deploymentId}.json`,
  );
  let state = await readDeployState(statePath);
  const commands = {
    typecheck: checkCommand(args, "--typecheck-command"),
    test: checkCommand(args, "--test-command"),
    build: checkCommand(args, "--build-command"),
  };
  const apiKey = io.env?.OPENGENI_API_KEY;
  const sessionCookie = io.env?.OPENGENI_SESSION_COOKIE;
  if (Boolean(apiKey) === Boolean(sessionCookie)) {
    throw new Error(
      "Set exactly one of OPENGENI_API_KEY or OPENGENI_SESSION_COOKIE for og-app deploy.",
    );
  }
  for (const credential of [apiKey, sessionCookie]) {
    if (credential && Object.values(commands).some((command) => command.includes(credential))) {
      throw new Error("App check commands must not contain the configured OpenGeni credential.");
    }
  }
  const runCheck = dependencies.runCheck ?? defaultRunCheck;
  const toolSelectors = options(args, "--allow-tool");
  if (
    toolSelectors.some((selector) => selector.length === 0 || selector.trim() !== selector) ||
    new Set(toolSelectors).size !== toolSelectors.length
  ) {
    throw new Error("--allow-tool selectors must be unique non-empty serverId/toolName values.");
  }
  const checks =
    state?.checks ??
    (["typecheck", "test", "build"] as const).map((kind) =>
      runCheck(kind, commands[kind], directory),
    );
  const entries = await collectDirectory(directory, statePath);
  const { sourceManifest } = validatePortableAppEntries(entries);
  const archive = createPortableAppArchive(entries);
  const sourceSha256 = sha256Hex(archive);
  const manifest = createAppBuildManifest(entries, sourceManifest.entryPath);
  const manifestSha256 = sha256Hex(new TextEncoder().encode(JSON.stringify(manifest)));
  if (!state) {
    state = {
      schemaVersion: 1,
      deploymentId,
      baseUrl,
      workspaceId,
      sourceSha256,
      sourceSizeBytes: archive.byteLength,
      checkCommands: commands,
      checks,
      allowedToolSelectors: toolSelectors,
    };
    await writeDeployState(statePath, state);
  } else if (
    state.deploymentId !== deploymentId ||
    state.baseUrl !== baseUrl ||
    state.workspaceId !== workspaceId ||
    state.sourceSha256 !== sourceSha256 ||
    state.sourceSizeBytes !== archive.byteLength ||
    JSON.stringify(state.checkCommands) !== JSON.stringify(commands) ||
    JSON.stringify(state.allowedToolSelectors) !== JSON.stringify(toolSelectors)
  ) {
    throw new Error("The deployment state does not match this App source or target.");
  }

  const createClient = dependencies.createAppsClient ?? defaultCreateAppsClient;
  const client = createClient({
    baseUrl,
    ...(apiKey ? { apiKey } : {}),
    ...(sessionCookie ? { sessionCookie } : {}),
  });
  const putSignedUpload = dependencies.putSignedUpload ?? defaultPutSignedUpload;

  let detail;
  if (state.appId) {
    if (requestedAppId && requestedAppId !== state.appId) {
      throw new Error("--app-id does not match the resumed deployment state.");
    }
    detail = await client.getApp(workspaceId, state.appId);
  } else if (requestedAppId) {
    detail = await client.getApp(workspaceId, requestedAppId);
    state.appId = detail.app.id;
    await writeDeployState(statePath, state);
  } else {
    const existing = await findAppBySlug(client, workspaceId, sourceManifest.slug);
    if (existing) {
      state.appId = existing.id;
    } else {
      const created = await client.createApp(workspaceId, {
        slug: sourceManifest.slug,
        title: sourceManifest.name,
        ...(sourceManifest.description === undefined
          ? {}
          : { description: sourceManifest.description }),
        idempotencyKey: stableOperationId(deploymentId, "create-app"),
      });
      state.appId = created.app.id;
    }
    await writeDeployState(statePath, state);
    detail = await client.getApp(workspaceId, state.appId);
  }
  const appId = state.appId;
  if (detail.app.status !== "active") throw new Error("The target App is not active.");

  let toolPolicy = state.toolPolicyRevisionId
    ? (detail.toolPolicies.find((candidate) => candidate.id === state.toolPolicyRevisionId) ?? null)
    : latestByRevision(detail.toolPolicies);
  if (!state.toolPolicyRevisionId && (!toolPolicy || toolSelectors.length > 0)) {
    const available = await client.getAvailableRuntimeCatalog(workspaceId, appId);
    state.policyExpectedVersion ??= detail.app.version;
    await writeDeployState(statePath, state);
    detail = await client.createToolPolicy(workspaceId, appId, {
      allowedTools: selectedToolIdentities(toolSelectors, available.tools),
      catalogDigest: available.catalogDigest,
      expectedAppVersion: state.policyExpectedVersion,
      idempotencyKey: stableOperationId(deploymentId, "tool-policy"),
    });
    toolPolicy = latestByRevision(detail.toolPolicies);
    if (!toolPolicy) throw new Error("OpenGeni did not return the created App tool policy.");
    state.toolPolicyRevisionId = toolPolicy.id;
    await writeDeployState(statePath, state);
  }
  if (!toolPolicy) throw new Error("The App tool policy is unavailable.");
  if (!state.toolPolicyRevisionId) {
    state.toolPolicyRevisionId = toolPolicy.id;
    await writeDeployState(statePath, state);
  }

  state.sourceExpectedVersion ??= detail.app.version;
  await writeDeployState(statePath, state);
  if (!state.sourceCompleted) {
    const source = await client.beginSourceUpload(workspaceId, appId, {
      format: "portable_tar_v1",
      contentSha256: sourceSha256,
      sizeBytes: archive.byteLength,
      expectedAppVersion: state.sourceExpectedVersion,
      idempotencyKey: stableOperationId(deploymentId, "source-begin"),
    });
    state.sourceRevisionId = source.sourceRevision.id;
    await writeDeployState(statePath, state);
    await putSignedUpload(source.stagingUpload, archive);
    detail = await client.completeSourceUpload(workspaceId, appId, state.sourceRevisionId, {
      expectedContentSha256: sourceSha256,
      expectedSizeBytes: archive.byteLength,
      fileCount: entries.length,
      idempotencyKey: stableOperationId(deploymentId, "source-complete"),
    });
    state.sourceCompleted = true;
    await writeDeployState(statePath, state);
  } else {
    detail = await client.getApp(workspaceId, appId);
  }
  if (!state.sourceRevisionId) throw new Error("The App source revision is unavailable.");

  state.buildExpectedVersion ??= detail.app.version;
  await writeDeployState(statePath, state);
  if (!state.buildCompleted) {
    let prepared = await client.prepareBuild(workspaceId, appId, {
      sourceRevisionId: state.sourceRevisionId,
      toolPolicyRevisionId: toolPolicy.id,
      manifestSha256,
      manifest,
      checks,
      expectedAppVersion: state.buildExpectedVersion,
      idempotencyKey: stableOperationId(deploymentId, "build-prepare"),
    });
    state.buildId = prepared.build.id;
    await writeDeployState(statePath, state);
    const entriesByPath = new Map(entries.map((entry) => [entry.path, entry.bytes]));
    for (;;) {
      for (const upload of prepared.uploads) {
        const bytes = entriesByPath.get(upload.path);
        if (!bytes) throw new Error(`OpenGeni requested an unknown App file: ${upload.path}.`);
        await putSignedUpload(upload.stagingUpload, bytes);
      }
      if (!prepared.nextCursor) break;
      const page = await client.listBuildUploads(workspaceId, appId, state.buildId, {
        cursor: prepared.nextCursor,
      });
      prepared = {
        ...prepared,
        uploads: page.uploads,
        nextCursor: page.nextCursor,
      };
    }
    const completed = await client.completeBuild(workspaceId, appId, state.buildId, {
      expectedManifestSha256: manifestSha256,
      idempotencyKey: stableOperationId(deploymentId, "build-complete"),
    });
    state.buildCompleted = true;
    state.promoteExpectedVersion ??= completed.app.version;
    await writeDeployState(statePath, state);
  }
  if (!state.buildId) throw new Error("The App build is unavailable.");

  if (!state.releaseId) {
    const current = await client.getApp(workspaceId, appId);
    state.promoteExpectedVersion ??= current.app.version;
    await writeDeployState(statePath, state);
    const promoted = await client.promoteBuild(workspaceId, appId, {
      buildId: state.buildId,
      expectedAppVersion: state.promoteExpectedVersion,
      idempotencyKey: stableOperationId(deploymentId, "release-promote"),
    });
    state.releaseId = promoted.release.id;
    await writeDeployState(statePath, state);
  }

  let previewUrl: string | undefined;
  if (args.includes("--preview")) {
    if (!state.previewId) {
      const preview = await client.createPreview(workspaceId, appId, {
        releaseId: state.releaseId,
        idempotencyKey: stableOperationId(deploymentId, "preview"),
      });
      state.previewId = preview.preview.id;
      previewUrl = preview.url;
      await writeDeployState(statePath, state);
    }
  }

  if (args.includes("--publish") && !state.published) {
    const current = await client.getApp(workspaceId, appId);
    state.publishExpectedVersion ??= current.app.version;
    await writeDeployState(statePath, state);
    await client.publish(workspaceId, appId, {
      releaseId: state.releaseId,
      expectedAppVersion: state.publishExpectedVersion,
      reason: option(args, "--reason") ?? `Deploy ${sourceManifest.appVersion} with og-app`,
      idempotencyKey: stableOperationId(deploymentId, "publish"),
    });
    state.published = true;
    await writeDeployState(statePath, state);
  }

  io.stdout(
    `${JSON.stringify(
      {
        deploymentId,
        statePath,
        appId,
        sourceRevisionId: state.sourceRevisionId,
        buildId: state.buildId,
        releaseId: state.releaseId,
        ...(state.previewId ? { previewId: state.previewId } : {}),
        ...(previewUrl ? { previewUrl } : {}),
        published: state.published === true,
      },
      null,
      2,
    )}\n`,
  );
  return 0;
}

export async function runOgAppCli(
  args: string[],
  io: OgAppCliIo = DEFAULT_IO,
  dependencies: OgAppCliDependencies = {},
): Promise<number> {
  const command = args[0];
  const rest = args.slice(1);
  if (!command || command === "--help" || command === "-h" || command === "help") {
    io.stdout(`${usage()}\n`);
    return command ? 0 : 1;
  }
  if (command === "init") return await initialize(rest, io);
  if (command === "validate") {
    const target = positional(rest)[0];
    if (!target) throw new Error("og-app validate requires a directory or archive.");
    return await validate(target, io);
  }
  if (command === "pack") return await pack(rest, io);
  if (command === "deploy") return await deploy(rest, io, dependencies);
  throw new Error(`Unknown og-app command ${command}.\n${usage()}`);
}
