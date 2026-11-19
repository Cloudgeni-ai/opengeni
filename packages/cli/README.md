# `opengeni`

The command-line interface for Opengeni.

```sh
npx opengeni --help
npx opengeni --version
```

`opengeni agents deploy [dir] [--dry-run] [--publish]` is reserved for deploying
agent definitions to an Opengeni organization. This version does not deploy
agents yet: the command explains that and exits with code 2, so scripts can
tell it apart from success (0) and usage errors (1).

The package version follows the other Opengeni packages. It is published only
by the repository release workflows.

Programmatic use:

```ts
import { runCli } from "opengeni";

const exitCode = runCli(["--version"]);
```
