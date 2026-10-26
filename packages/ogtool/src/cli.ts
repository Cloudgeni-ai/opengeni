import { randomUUID } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import {
  CodemodeClient,
  CodemodeApprovalPendingError,
  CodemodeOperationError,
  generateCodemodeDeclarations,
  materializeCodemodeImages,
  type AttemptToolCatalog,
  type AttemptToolCatalogEntry,
} from "@opengeni/codemode";
import { omitStructuredContentTextDuplicates, type AttemptToolResult } from "@opengeni/contracts";
import packageManifest from "../package.json" with { type: "json" };
import { compactOutput, parseListOptions } from "./catalog-discovery";
import { readToolArguments } from "./tool-argument-source";

const PACKAGE_NAME = "@opengeni/ogtool";
const VERSION = packageManifest.version;

function usage(exitCode = 1): void {
  const output = [
    "usage:",
    "  ogtool list [--full | --json]",
    "              [--query <substring>] [--limit <1..100>] [--offset <nonnegative integer>]",
    "  ogtool show <tool-path-or-model-name>",
    "  ogtool call <tool-path-or-model-name> [json-object | @file | -] [--full] [--save-image <path>]",
    "  ogtool read <operation-id>",
    "  ogtool resume <operation-id>",
    "  ogtool declarations [output-file]",
    "  ogtool doctor",
    "  ogtool --version",
    "",
    "list returns all authorized tools by default; --limit/--offset are opt-in slices",
    "call reads its arguments inline, from a file with @path, or from stdin with -;",
    "  use a file or stdin for large arguments",
    "call omits a text block that only repeats structuredContent; --full prints the exact result",
    "call writes images (such as screenshots) to files and prints their paths instead of base64;",
    "  --save-image saves the result's single image at that path and never overwrites",
    "  if the call completes but its image cannot be saved, the result is still printed",
    "  with imageSaveError and the exit code is 4; do not repeat that call",
    "",
    "requires OPENGENI_CODEMODE_URL and OPENGENI_CODEMODE_TOKEN or OPENGENI_CODEMODE_TOKEN_FILE",
  ].join("\n");
  (exitCode === 0 ? process.stdout : process.stderr).write(`${output}\n`);
  process.exitCode = exitCode;
}

function configuredClient(): CodemodeClient {
  const baseUrl = process.env.OPENGENI_CODEMODE_URL?.trim();
  const directTokenConfigured = process.env.OPENGENI_CODEMODE_TOKEN !== undefined;
  const tokenFile = process.env.OPENGENI_CODEMODE_TOKEN_FILE?.trim();
  if (!baseUrl) throw new Error("OPENGENI_CODEMODE_URL is required");
  if (!directTokenConfigured && !tokenFile) {
    throw new Error("OPENGENI_CODEMODE_TOKEN or OPENGENI_CODEMODE_TOKEN_FILE is required");
  }
  return new CodemodeClient({
    baseUrl,
    token: directTokenConfigured
      ? async () => requiredDirectToken()
      : async () => readToken(tokenFile!),
  });
}

function requiredDirectToken(): string {
  const token = process.env.OPENGENI_CODEMODE_TOKEN?.trim();
  if (!token) throw new Error("OPENGENI_CODEMODE_TOKEN is empty");
  return token;
}

function readToken(tokenFile: string): string {
  let token: string;
  try {
    token = readFileSync(tokenFile, "utf8").trim();
  } catch {
    throw new Error("OPENGENI_CODEMODE_TOKEN_FILE is not readable");
  }
  if (!token) throw new Error("OPENGENI_CODEMODE_TOKEN_FILE is empty");
  return token;
}

function doctor(): void {
  const directTokenRaw = process.env.OPENGENI_CODEMODE_TOKEN;
  const directTokenConfigured = directTokenRaw !== undefined;
  const directTokenNonempty = Boolean(directTokenRaw?.trim().length);
  const tokenFile = process.env.OPENGENI_CODEMODE_TOKEN_FILE ?? null;
  const rawUrl = process.env.OPENGENI_CODEMODE_URL ?? null;
  let urlValid = false;
  let protocol: string | null = null;
  if (rawUrl) {
    try {
      const target = new URL(rawUrl);
      protocol = target.protocol;
      urlValid = protocol === "http:" || protocol === "https:";
    } catch {
      urlValid = false;
    }
  }
  let tokenFileReadable = false;
  let tokenFileNonempty = false;
  if (tokenFile) {
    try {
      tokenFileReadable = statSync(tokenFile).isFile();
      tokenFileNonempty = tokenFileReadable && readFileSync(tokenFile, "utf8").trim().length > 0;
    } catch {
      tokenFileReadable = false;
    }
  }
  const tokenMode = directTokenConfigured ? "environment" : tokenFile ? "file" : null;
  const tokenReady = directTokenConfigured ? directTokenNonempty : tokenFileNonempty;
  const ok = urlValid && tokenReady;
  process.stdout.write(
    `${JSON.stringify(
      {
        ok,
        package: PACKAGE_NAME,
        version: VERSION,
        node: process.version,
        urlConfigured: rawUrl !== null,
        urlValid,
        protocol,
        tokenMode,
        directTokenConfigured,
        directTokenNonempty,
        tokenFileConfigured: tokenFile !== null,
        tokenFileReadable,
        tokenFileNonempty,
        packageSpec: process.env.OPENGENI_OGTOOL_PACKAGE_SPEC ?? null,
      },
      null,
      2,
    )}\n`,
  );
  process.exitCode = ok ? 0 : 1;
}

export function resolveTool(catalog: AttemptToolCatalog, name: string): AttemptToolCatalogEntry {
  const matches = catalog.entries.filter(
    (entry) =>
      entry.modelName === name ||
      entry.codemodePath.join(".") === name ||
      `${entry.identity.serverId}.${entry.identity.toolName}` === name,
  );
  if (matches.length !== 1) {
    throw new Error(
      matches.length === 0 ? `Unknown Codemode tool: ${name}` : `Ambiguous tool: ${name}`,
    );
  }
  return matches[0]!;
}

export function listProjection(catalog: AttemptToolCatalog): Record<string, unknown> {
  return {
    catalogDigest: catalog.digest,
    attemptId: catalog.attemptId,
    tools: catalog.entries.map((entry) => ({
      name: entry.modelName,
      path: entry.codemodePath.join("."),
      identity: entry.identity,
      ...(entry.title ? { title: entry.title } : {}),
      ...(entry.description ? { description: entry.description } : {}),
      inputSchema: entry.inputSchema,
      ...(entry.outputSchema ? { outputSchema: entry.outputSchema } : {}),
      ...(entry.annotations ? { annotations: entry.annotations } : {}),
      approval: entry.approval,
      source: entry.source,
    })),
  };
}

export function showOutput(catalog: AttemptToolCatalog, name: string): string {
  const entry = resolveTool(catalog, name);
  const projection = listProjection({ ...catalog, entries: [entry] });
  const output = JSON.stringify((projection.tools as unknown[])[0], null, 2);
  return `${output}\n`;
}

/**
 * `call` prints the payload once by default: a text block that only repeats
 * `structuredContent` as JSON is omitted. `--full` prints the exact result.
 * The native client (`codemode call`) applies the same rule.
 */
export function callOutput(result: AttemptToolResult, full = false): string {
  const printed = full ? result : omitStructuredContentTextDuplicates(result);
  return `${JSON.stringify(printed, null, 2)}\n`;
}

/**
 * Write a result's image blocks to files, as `tab.screenshot()` does, and,
 * unless the exact result was requested, print each as
 * `{type, mimeType, path, sizeBytes}` instead of base64 pixels. The native
 * client (`codemode call`) does the same.
 */
export async function materializeCallImages(
  result: AttemptToolResult,
  options: { saveTo?: string; full?: boolean } = {},
): Promise<AttemptToolResult> {
  if (options.full && options.saveTo === undefined) return result;
  const images = await materializeCodemodeImages(result, {
    ...(options.saveTo === undefined ? {} : { saveTo: options.saveTo }),
  });
  if (options.saveTo !== undefined && images.length !== 1) {
    throw new Error("--save-image needs a result with exactly one image");
  }
  if (options.full || images.length === 0) return result;
  let next = 0;
  return {
    ...result,
    content: result.content.map((block) => {
      if (block.type !== "image") return block;
      const image = images[next++]!;
      return {
        type: "image",
        mimeType: image.mimeType,
        path: image.path,
        sizeBytes: image.sizeBytes,
      } as unknown as (typeof result.content)[number];
    }),
  };
}

/**
 * Refuse a --save-image path before the tool runs when the file could not be
 * written anyway, so nothing is called for a screenshot that cannot be kept.
 */
export function preflightImagePath(saveTo: string): void {
  const path = resolve(saveTo);
  let exists = true;
  try {
    lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    exists = false;
  }
  if (exists) {
    throw new Error(`--save-image ${path} already exists; choose a new path (nothing was called)`);
  }
  mkdirSync(dirname(path), { recursive: true });
  accessSync(dirname(path), constants.W_OK);
}

/**
 * The tool call already completed, so a failure to save its image must not
 * hide the result: print it (images kept in a private temporary file when
 * possible) with the save error and the operation ID.
 */
export async function imageSaveFailureOutput(
  result: AttemptToolResult,
  error: unknown,
  operationId: string,
  full: boolean,
): Promise<string> {
  let printed = result;
  if (!full) {
    try {
      printed = await materializeCallImages(result);
    } catch {
      printed = result;
    }
  }
  return callOutput(
    {
      ...printed,
      imageSaveError: {
        operationId,
        message: error instanceof Error ? error.message : String(error),
        note: "The call completed; only saving its image failed. Do not repeat the call.",
      },
    } as AttemptToolResult,
    full,
  );
}

function callFlags(args: string[]): { full: boolean; saveTo?: string; rest: string[] } {
  let full = false;
  let saveTo: string | undefined;
  const rest: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--full") full = true;
    else if (arg === "--save-image") {
      const value = args[++index];
      if (!value) throw new Error("--save-image requires a path");
      saveTo = value;
    } else if (arg.startsWith("--save-image=")) {
      saveTo = arg.slice("--save-image=".length);
      if (!saveTo) throw new Error("--save-image requires a path");
    } else rest.push(arg);
  }
  return { full, ...(saveTo === undefined ? {} : { saveTo }), rest };
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === "--help" || command === "-h" || command === "help") return usage(0);
  if (command === "--version" || command === "-V" || command === "version") {
    process.stdout.write(`${VERSION}\n`);
    return;
  }
  if (command === "doctor") return doctor();
  if (!command) return usage();

  const args = process.argv.slice(3);
  if (
    (command === "list" || command === "show") &&
    args.length === 1 &&
    (args[0] === "--help" || args[0] === "-h")
  )
    return usage(0);
  const listOptions = command === "list" ? parseListOptions(args) : null;
  if (command === "show" && (args.length !== 1 || !args[0] || args[0].startsWith("-"))) {
    throw new Error("usage: ogtool show <tool-path-or-model-name>");
  }

  const client = configuredClient();
  if (command === "read" || command === "resume") {
    if (args.length !== 1 || !/^[0-9a-f-]{36}$/iu.test(args[0]!))
      throw new Error("A valid operation ID is required");
    const result =
      command === "read" ? await client.status(args[0]!) : await client.resume(args[0]!);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  if (command === "list") {
    const catalog = await client.catalog();
    if (listOptions!.full) {
      process.stdout.write(`${JSON.stringify(listProjection(catalog), null, 2)}\n`);
    } else {
      process.stdout.write(compactOutput(catalog, listOptions!));
    }
    return;
  }
  if (command === "show") {
    process.stdout.write(showOutput(await client.catalog(), args[0]!));
    return;
  }
  if (command === "call") {
    const { full, saveTo, rest } = callFlags(args);
    const [name, rawArguments] = rest;
    if (!name) throw new Error("tool path or model name is required");
    const argumentsValue = await readToolArguments(rawArguments);
    const catalog = await client.catalog();
    const entry = resolveTool(catalog, name);
    if (saveTo !== undefined) preflightImagePath(saveTo);
    const operationId = randomUUID();
    const result = await client.call(entry.identity, argumentsValue, { operationId });
    // An error result has no image to save; print it as the call's answer
    // rather than as a completed call whose image could not be saved.
    const saveImage = result.isError === true ? undefined : saveTo;
    let printed: AttemptToolResult;
    try {
      printed = await materializeCallImages(result, {
        full,
        ...(saveImage === undefined ? {} : { saveTo: saveImage }),
      });
    } catch (error) {
      process.stdout.write(await imageSaveFailureOutput(result, error, operationId, full));
      process.exitCode = 4;
      return;
    }
    process.stdout.write(callOutput(printed, full));
    return;
  }
  if (command === "declarations") {
    const catalog = await client.catalog();
    const declaration = generateCodemodeDeclarations(catalog);
    const output = process.argv[3];
    if (!output || output === "-") {
      process.stdout.write(declaration);
    } else {
      writeFileSync(output, declaration, { encoding: "utf8", mode: 0o600 });
      process.stdout.write(
        `${JSON.stringify({ catalogDigest: catalog.digest, output }, null, 2)}\n`,
      );
    }
    return;
  }
  return usage();
}

void main().catch((error: unknown) => {
  if (error instanceof CodemodeApprovalPendingError) {
    process.stdout.write(
      `${JSON.stringify({ operationId: error.operationId, state: error.state, code: error.code, approvalRequestId: error.approvalRequestId, message: error.message })}\n`,
    );
    process.exitCode = 2;
    return;
  }
  if (error instanceof CodemodeOperationError) {
    process.stdout.write(
      `${JSON.stringify({ operationId: error.operation.operationId, state: error.operation.state, code: error.code, message: error.message })}\n`,
    );
    process.exitCode = error.operation.state === "outcome_unknown" ? 3 : 1;
    return;
  }
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = code === "tool_outcome_unknown" ? 3 : 1;
});
