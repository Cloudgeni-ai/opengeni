import { randomUUID } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import {
  CodemodeClient,
  generateCodemodeDeclarations,
  type AttemptToolCatalog,
  type AttemptToolCatalogEntry,
} from "@opengeni/codemode";
import packageManifest from "../package.json" with { type: "json" };
import { compactOutput, parseListOptions } from "./catalog-discovery";

const PACKAGE_NAME = "@opengeni/ogtool";
const VERSION = packageManifest.version;

function usage(exitCode = 1): void {
  const output = [
    "usage:",
    "  ogtool list [--full | --json]",
    "              [--query <substring>] [--limit <1..100>] [--offset <nonnegative integer>]",
    "  ogtool show <tool-path-or-model-name>",
    "  ogtool call <tool-path-or-model-name> [json-object]",
    "  ogtool declarations [output-file]",
    "  ogtool doctor",
    "  ogtool --version",
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

const SHOW_MAX_BYTES = 64 * 1024;

export function showOutput(catalog: AttemptToolCatalog, name: string): string {
  const entry = resolveTool(catalog, name);
  const projection = listProjection({ ...catalog, entries: [entry] });
  const output = JSON.stringify((projection.tools as unknown[])[0], null, 2);
  if (Buffer.byteLength(output, "utf8") + 1 > SHOW_MAX_BYTES) {
    throw new Error("Tool details exceed 65536 bytes; use list --full or declarations <output-file>");
  }
  return `${output}\n`;
}

export function parseToolArguments(raw: string | undefined): Record<string, unknown> {
  if (raw === undefined) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error("tool arguments must be valid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("tool arguments must be a JSON object");
  }
  return value as Record<string, unknown>;
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
  ) return usage(0);
  const listOptions = command === "list" ? parseListOptions(args) : null;
  if (command === "show" && (args.length !== 1 || !args[0] || args[0].startsWith("-"))) {
    throw new Error("usage: ogtool show <tool-path-or-model-name>");
  }

  const client = configuredClient();
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
    const name = process.argv[3];
    if (!name) throw new Error("tool path or model name is required");
    const argumentsValue = parseToolArguments(process.argv[4]);
    const catalog = await client.catalog();
    const entry = resolveTool(catalog, name);
    const result = await client.call(entry.identity, argumentsValue, {
      operationId: randomUUID(),
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
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
  const code =
    error && typeof error === "object" && "code" in error
      ? String((error as { code: unknown }).code)
      : null;
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = code === "tool_outcome_unknown" ? 3 : 1;
});
