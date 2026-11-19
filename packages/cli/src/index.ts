import packageManifest from "../package.json" with { type: "json" };

/** npm package name of the Opengeni command-line interface. */
export const OPENGENI_CLI_PACKAGE_NAME = "opengeni" as const;

/** Version of this command-line interface (the Opengeni lockstep release). */
export const OPENGENI_CLI_VERSION: string = packageManifest.version;

/** Where the command-line interface writes its output. */
export type CliIo = {
  stdout(text: string): void;
  stderr(text: string): void;
};

/** Exit codes returned by {@link runCli}. */
export const CLI_EXIT = {
  ok: 0,
  usage: 1,
  unavailable: 2,
} as const;

const USAGE = `Usage: opengeni <command> [options]

Commands:
  agents deploy [dir] [--dry-run] [--publish]   Deploy agent definitions to an organization

Options:
  -h, --help       Show this help
  -v, --version    Show the installed version
`;

const processIo: CliIo = {
  stdout: (text) => process.stdout.write(text),
  stderr: (text) => process.stderr.write(text),
};

function isHelp(argument: string | undefined): boolean {
  return argument === "--help" || argument === "-h" || argument === "help";
}

/**
 * Run the `opengeni` command with its arguments (without the runtime and
 * script path) and return the process exit code.
 */
export function runCli(argv: readonly string[], io: CliIo = processIo): number {
  const [command, subcommand] = argv;
  if (command === undefined || isHelp(command)) {
    io.stdout(USAGE);
    return CLI_EXIT.ok;
  }
  if (command === "--version" || command === "-v" || command === "version") {
    io.stdout(`${OPENGENI_CLI_VERSION}\n`);
    return CLI_EXIT.ok;
  }
  if (command === "agents") {
    if (isHelp(subcommand)) {
      io.stdout(USAGE);
      return CLI_EXIT.ok;
    }
    if (subcommand === "deploy") {
      io.stderr(
        `opengeni agents deploy is not available in opengeni ${OPENGENI_CLI_VERSION} yet. ` +
          "Update the opengeni package to a newer version to deploy agents.\n",
      );
      return CLI_EXIT.unavailable;
    }
    io.stderr(
      subcommand === undefined
        ? "opengeni agents needs a subcommand.\n\n"
        : `Unknown command: opengeni agents ${subcommand}\n\n`,
    );
    io.stderr(USAGE);
    return CLI_EXIT.usage;
  }
  io.stderr(`Unknown command: opengeni ${command}\n\n`);
  io.stderr(USAGE);
  return CLI_EXIT.usage;
}
