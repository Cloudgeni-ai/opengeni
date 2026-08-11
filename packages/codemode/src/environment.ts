import { readFile } from "node:fs/promises";
import { CodemodeClient, type CodemodeCallOptions, type CodemodeToolFunction } from "./index";

export const CODEMODE_ENVIRONMENT = {
  url: "OPENGENI_CODEMODE_URL",
  tokenFile: "OPENGENI_CODEMODE_TOKEN_FILE",
} as const;

export type CodemodeClientProvider = () => CodemodeClient | Promise<CodemodeClient>;

/** A lazy catalog path. Every nested property remains callable at runtime. */
export type CodemodeDynamicTool = CodemodeToolFunction & {
  readonly [segment: string]: CodemodeDynamicTool;
};

export type CodemodeDynamicTools = {
  readonly [segment: string]: CodemodeDynamicTool;
};

/** Catalog-specific generated declarations augment this interface. */
export interface CodemodeGeneratedTools {}

export type CodemodeToolsNamespace = CodemodeDynamicTools & CodemodeGeneratedTools;

let cachedEnvironmentClient: { key: string; client: CodemodeClient } | null = null;

/**
 * Build (or reuse) the persistent client for the exact sandbox attempt.
 * The bearer file is reread for every HTTP request so worker renewal is live.
 */
export function environmentCodemodeClient(
  environment: NodeJS.ProcessEnv = process.env,
): CodemodeClient {
  const baseUrl = requiredEnvironment(environment, CODEMODE_ENVIRONMENT.url);
  const tokenFile = requiredEnvironment(environment, CODEMODE_ENVIRONMENT.tokenFile);
  const key = `${baseUrl}\u0000${tokenFile}`;
  if (environment === process.env && cachedEnvironmentClient?.key === key) {
    return cachedEnvironmentClient.client;
  }
  const client = new CodemodeClient({
    baseUrl,
    token: async () => await readBearerFile(tokenFile),
  });
  if (environment === process.env) cachedEnvironmentClient = { key, client };
  return client;
}

/**
 * Lazy namespace used by ordinary sandbox programs:
 * `await tools.slack.search({ query: "..." })`.
 */
export function createCodemodeTools(
  client: CodemodeClientProvider = () => environmentCodemodeClient(),
): CodemodeToolsNamespace {
  const node = (path: readonly string[]): CodemodeDynamicTool =>
    new Proxy(
      (async (args: Record<string, unknown> = {}, options: CodemodeCallOptions = {}) =>
        await (await client()).callPathValue(path, args, options)) as CodemodeDynamicTool,
      {
        get(_target, property) {
          if (property === "then") return undefined;
          if (property === Symbol.toStringTag) return "CodemodeTool";
          if (typeof property !== "string") return undefined;
          return node([...path, property]);
        },
        set() {
          return false;
        },
      },
    );
  return new Proxy(Object.create(null) as CodemodeToolsNamespace, {
    get(_target, property) {
      if (property === "then") return undefined;
      if (property === Symbol.toStringTag) return "CodemodeTools";
      if (typeof property !== "string") return undefined;
      return node([property]);
    },
    set() {
      return false;
    },
  });
}

export const tools = createCodemodeTools();

async function readBearerFile(path: string): Promise<string> {
  let token: string;
  try {
    token = (await readFile(path, "utf8")).trim();
  } catch {
    throw new Error(`${CODEMODE_ENVIRONMENT.tokenFile} is not readable`);
  }
  if (!token) throw new Error(`${CODEMODE_ENVIRONMENT.tokenFile} is empty`);
  return token;
}

function requiredEnvironment(environment: NodeJS.ProcessEnv, name: string): string {
  const value = environment[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}
