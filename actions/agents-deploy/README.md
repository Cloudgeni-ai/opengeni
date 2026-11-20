# Deploy Opengeni agents

A composite GitHub Action that runs `npx opengeni agents deploy` for a
directory of agent files (`agents/<key>.yaml`, one agent per file). See
[Console agents](../../docs/agents.md#console-agents) for the file format.

```yaml
name: Deploy agents
on:
  push:
    branches: [main]
    paths: ["agents/**"]
  pull_request:
    paths: ["agents/**"]

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - uses: Cloudgeni-ai/opengeni/actions/agents-deploy@main
        with:
          directory: agents
          # Dry run on pull requests, publish on main.
          dry-run: ${{ github.event_name == 'pull_request' }}
          publish: ${{ github.event_name == 'push' }}
          organization-id: ${{ vars.OPENGENI_ORGANIZATION_ID }}
          api-key: ${{ secrets.OPENGENI_API_KEY }}
```

| Input | Default | Meaning |
| --- | --- | --- |
| `directory` | `agents` | Directory with the agent files. |
| `publish` | `false` | Publish the deployed versions. |
| `move-running-chats` | `false` | With `publish`, also move running chats to the new versions. |
| `dry-run` | `false` | Show what would change without saving. |
| `organization-id` | (required) | The Opengeni organization id. |
| `api-key` | (required) | An organization API key with `agents:manage`, from a secret. |
| `base-url` | `https://app.opengeni.ai` | The Opengeni API URL. |
| `version` | `latest` | The `opengeni` npm package version to run; pin it for repeatable deploys. |

The step fails when any file is invalid (nothing is deployed then) or any
agent fails to deploy, for example one managed in Console. Each agent prints
one line: key, `created`/`updated`/`unchanged`, version, whether it is
published, and its config hash.
