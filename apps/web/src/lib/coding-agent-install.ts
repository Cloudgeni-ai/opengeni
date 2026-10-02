/**
 * Every install string the app shows for coding agents, in one place so they
 * are easy to update.
 *
 * - The Opengeni Developer plugin is skills-only (`opengeni-setup` and
 *   `opengeni-client`, no MCP server). It comes from the `Cloudgeni-ai/opengeni`
 *   repository's marketplace; see docs/developer-plugin.md there.
 * - The workspace MCP server is separate: it lets a coding agent hand work to
 *   Opengeni, and signs in with MCP OAuth.
 */

export const DEVELOPER_PLUGIN = {
  /** The GitHub repository that is the marketplace and the plugin root. */
  repository: "Cloudgeni-ai/opengeni",
  repositoryUrl: "https://github.com/Cloudgeni-ai/opengeni",
  marketplace: "opengeni-developer-plugins",
  plugin: "opengeni-developer",
  /** As Cursor lists it after importing the repository. */
  displayName: "OpenGeni Developer",
  docsUrl: "https://docs.opengeni.ai/guides/developer-plugin",
  skills: { setup: "opengeni-setup", client: "opengeni-client" },
} as const;

const PLUGIN_ID = `${DEVELOPER_PLUGIN.plugin}@${DEVELOPER_PLUGIN.marketplace}`;

export const DEVELOPER_PLUGIN_INSTALL = {
  claude: [
    `claude plugin marketplace add ${DEVELOPER_PLUGIN.repository}`,
    `claude plugin install ${PLUGIN_ID} --scope user`,
  ],
  codex: [
    `codex plugin marketplace add ${DEVELOPER_PLUGIN.repository}`,
    `codex plugin add ${PLUGIN_ID}`,
  ],
  /** Cursor imports the repository in Customize > From GitHub Repository. */
  cursorRepository: DEVELOPER_PLUGIN.repositoryUrl,
  /** Agents without plugins read the two skills from `.agents/skills`. */
  skillsCopy: [
    `git clone --depth 1 --filter=blob:none --sparse ${DEVELOPER_PLUGIN.repositoryUrl}.git /tmp/opengeni-skills`,
    `git -C /tmp/opengeni-skills sparse-checkout set .agents/skills/${DEVELOPER_PLUGIN.skills.setup} .agents/skills/${DEVELOPER_PLUGIN.skills.client}`,
    `mkdir -p .agents/skills && cp -R /tmp/opengeni-skills/.agents/skills/${DEVELOPER_PLUGIN.skills.setup} /tmp/opengeni-skills/.agents/skills/${DEVELOPER_PLUGIN.skills.client} .agents/skills/`,
  ],
} as const;

/** Adding the workspace MCP server, per agent. */
export const MCP_SERVER_INSTALL = {
  claude: (url: string) => [`claude mcp add --scope user --transport http opengeni ${url}`],
  codex: (url: string) => [`codex mcp add opengeni --url ${url}`],
  cursor: (url: string) => `{ "mcpServers": { "opengeni": { "url": "${url}" } } }`,
  vscode: (url: string) => [`code --add-mcp '{"name":"opengeni","type":"http","url":"${url}"}'`],
} as const;
