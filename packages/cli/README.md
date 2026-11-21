# `opengeni`

The command-line interface for Opengeni.

```sh
npx opengeni --help
npx opengeni --version
```

## Deploy agents

```sh
export OPENGENI_API_KEY=...          # organization key with agents:manage
export OPENGENI_ORGANIZATION_ID=...
npx opengeni agents deploy agents --dry-run
npx opengeni agents deploy agents --publish
npx opengeni agents export support --out agents
```

`agents deploy [dir]` reads every `*.yaml`/`*.yml` file in `dir` (default
`agents`), one agent per file named after its key. `instructions` may name a
`.md` file next to the YAML file; a missing one is an error. Every file is checked first; nothing is
deployed while one has a problem. Each agent prints one line: key, outcome
(`created`, `updated`, `unchanged`), version, published or not, and its config
hash. `--dry-run` writes nothing; each line says `would create vN` or
`unchanged`, followed by the agent's changes against its published version. Options: `--dry-run`, `--publish`, `--move-running-chats` (with
`--publish`), `--json`, `--organization <id>`, `--base-url <url>` (default
`OPENGENI_BASE_URL` or `https://app.opengeni.ai`). The exit code is 0 when
every agent deployed and 1 otherwise.

Agent files can start with
`# yaml-language-server: $schema=https://cdn.jsdelivr.net/npm/opengeni/schemas/agent.schema.json`
for completion and checks in editors. The schema is in this package
(`schemas/agent.schema.json`), generated from the `OrgAgentFile` contract.
See [Console agents](../../docs/agents.md#console-agents).

The package version follows the other Opengeni packages. It is published only
by the repository release workflows. A CLI-only release
(`.github/workflows/publish-cli.yml`) ships just the self-contained `opengeni`
command, without the programmatic entry below.

Programmatic use:

```ts
import { runCli } from "opengeni";

const exitCode = await runCli(["--version"]);
```
