import packageManifest from "../package.json" with { type: "json" };
import { deployAgents, exportAgent } from "./agents";
import { DEFAULT_OPENGENI_BASE_URL, type FetchLike } from "./api";

export {
  type LoadedAgentFile,
  loadAgentDirectory,
  loadAgentFile,
  orgAgentConfigHash,
} from "./agent-files";
export { type DeployResult, renderAgentFile } from "./agents";
export { CliApiError, DEFAULT_OPENGENI_BASE_URL, type FetchLike } from "./api";

/** npm package name of the Opengeni command-line interface. */
export const OPENGENI_CLI_PACKAGE_NAME = "opengeni" as const;

/** Version of this command-line interface (the Opengeni lockstep release). */
export const OPENGENI_CLI_VERSION: string = packageManifest.version;

/**
 * Where the command-line interface writes its output, plus optional overrides
 * (environment, working directory, fetch) for programmatic use and tests.
 */
export type CliIo = {
  stdout(text: string): void;
  stderr(text: string): void;
  env?: Readonly<Record<string, string | undefined>>;
  cwd?: string;
  fetch?: FetchLike;
};

/** Exit codes returned by {@link runCli}. */
export const CLI_EXIT = {
  ok: 0,
  /** A usage error, invalid agent files, or a failed deploy. */
  usage: 1,
  failed: 1,
} as const;

const USAGE = `Usage: opengeni <command> [options]

Commands:
  agents deploy [dir]        Deploy agents/<key>.yaml files to an organization (default dir: agents)
    --dry-run                Show the change against the published version without saving
    --publish                Publish the deployed versions
    --move-running-chats     With --publish, also move running chats to the new versions
    --json                   Print the results as JSON
  agents export <key>        Print an agent as YAML
    --out <dir>              Write <key>.yaml (and <key>.md for long instructions) to <dir>

Options:
  --organization <id>        Organization id (default: OPENGENI_ORGANIZATION_ID)
  --base-url <url>           API URL (default: OPENGENI_BASE_URL or ${DEFAULT_OPENGENI_BASE_URL})
  -h, --help                 Show this help
  -v, --version              Show the installed version

Environment:
  OPENGENI_API_KEY           Organization API key with agents:manage (required)
`;

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function isHelp(argument: string | undefined): boolean {
  return argument === "--help" || argument === "-h" || argument === "help";
}

const BOOLEAN_FLAGS = new Set(["dry-run", "publish", "move-running-chats", "json", "help"]);
const VALUE_FLAGS = new Set(["organization", "base-url", "out"]);

type ParsedArgs = {
  positionals: string[];
  flags: Map<string, string | true>;
  errors: string[];
};

function parseArgs(argv: readonly string[]): ParsedArgs {
  const parsed: ParsedArgs = { positionals: [], flags: new Map(), errors: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "-h") {
      parsed.flags.set("help", true);
      continue;
    }
    if (!argument.startsWith("--") || argument === "--") {
      if (argument !== "--") parsed.positionals.push(argument);
      continue;
    }
    const [name, inline] = argument.slice(2).split(/=(.*)/su, 2) as [string, string | undefined];
    if (BOOLEAN_FLAGS.has(name)) {
      if (inline === undefined) parsed.flags.set(name, true);
      else if (inline === "true" || inline === "false") {
        if (inline === "true") parsed.flags.set(name, true);
      } else parsed.errors.push(`--${name} takes no value.`);
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = inline ?? argv[index + 1];
      if (value === undefined || (inline === undefined && value.startsWith("--"))) {
        parsed.errors.push(`--${name} needs a value.`);
        continue;
      }
      if (inline === undefined) index += 1;
      parsed.flags.set(name, value);
      continue;
    }
    parsed.errors.push(`unknown option --${name}.`);
  }
  return parsed;
}

function nonEmpty(value: string | true | undefined): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/**
 * Run the `opengeni` command with its arguments (without the runtime and
 * script path) and resolve to the process exit code.
 */
export async function runCli(argv: readonly string[], io: CliIo = processIo): Promise<number> {
  const [command, subcommand] = argv;
  if (command === undefined || isHelp(command)) {
    io.stdout(USAGE);
    return CLI_EXIT.ok;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    io.stdout(`${OPENGENI_CLI_VERSION}\n`);
    return CLI_EXIT.ok;
  }
  if (command !== "agents") {
    io.stderr(`Unknown command: opengeni ${command}\n\n`);
    io.stderr(USAGE);
    return CLI_EXIT.usage;
  }
  if (isHelp(subcommand)) {
    io.stdout(USAGE);
    return CLI_EXIT.ok;
  }
  if (subcommand !== "deploy" && subcommand !== "export") {
    io.stderr(
      subcommand === undefined
        ? "opengeni agents needs a subcommand.\n\n"
        : `Unknown command: opengeni agents ${subcommand}\n\n`,
    );
    io.stderr(USAGE);
    return CLI_EXIT.usage;
  }
  const args = parseArgs(argv.slice(2));
  if (args.flags.has("help")) {
    io.stdout(USAGE);
    return CLI_EXIT.ok;
  }
  const env = io.env ?? process.env;
  const cwd = io.cwd ?? process.cwd();
  if (subcommand === "deploy" && args.positionals.length > 1) {
    args.errors.push(`expected one directory, got ${args.positionals.length}.`);
  }
  if (subcommand === "export" && args.positionals.length !== 1) {
    args.errors.push("expected the agent key: opengeni agents export <key>.");
  }
  if (subcommand === "deploy" && args.flags.has("out"))
    args.errors.push("--out is only for agents export.");
  if (args.flags.has("move-running-chats") && !args.flags.has("publish")) {
    io.stderr("warning: --move-running-chats has no effect without --publish.\n");
  }
  const apiKey = nonEmpty(env.OPENGENI_API_KEY);
  const organizationId =
    nonEmpty(args.flags.get("organization")) ?? nonEmpty(env.OPENGENI_ORGANIZATION_ID);
  const baseUrl =
    nonEmpty(args.flags.get("base-url")) ??
    nonEmpty(env.OPENGENI_BASE_URL) ??
    DEFAULT_OPENGENI_BASE_URL;
  if (!apiKey)
    args.errors.push("set OPENGENI_API_KEY to an organization API key with agents:manage.");
  if (!organizationId)
    args.errors.push("set OPENGENI_ORGANIZATION_ID or pass --organization <id>.");
  if (args.errors.length > 0) {
    for (const error of args.errors) io.stderr(`error: ${error}\n`);
    io.stderr("Run opengeni --help for usage.\n");
    return CLI_EXIT.usage;
  }
  const api = {
    baseUrl,
    apiKey: apiKey!,
    fetch: io.fetch ?? ((input: string, init?: RequestInit) => fetch(input, init)),
    userAgent: `opengeni-cli/${OPENGENI_CLI_VERSION}`,
  };
  if (subcommand === "export") {
    return await exportAgent(
      api,
      {
        key: args.positionals[0]!,
        organizationId: organizationId!,
        outDirectory: nonEmpty(args.flags.get("out")),
        cwd,
      },
      io,
    );
  }
  const { exitCode } = await deployAgents(
    api,
    {
      directory: args.positionals[0] ?? "agents",
      organizationId: organizationId!,
      publish: args.flags.has("publish"),
      moveRunningChats: args.flags.has("move-running-chats"),
      dryRun: args.flags.has("dry-run"),
      json: args.flags.has("json"),
      cwd,
    },
    io,
  );
  return exitCode;
}
