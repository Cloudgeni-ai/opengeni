import { blocks, type AgentPromptModule } from "../types";

/**
 * The client renders plain Markdown (Slack, the chat facade, a product's own
 * UI). Replaces the `sandbox:`/`artifact:` link and inline-visual rules.
 */
export const rendererMarkdownModule: AgentPromptModule = {
  id: "renderer_markdown",
  applies: (context) => context.renderer === "markdown",
  render: () =>
    blocks(
      "# Links and rendering",
      "Your answer is shown as ordinary Markdown in a client that cannot open workspace file links or render inline HTML. Do not write `sandbox:` or `artifact:` links, inline HTML, or embedded images of workspace files. Mention a workspace file by its path in backticks, and link only to web URLs the user can open, such as a canonical link a tool returns.",
    ),
};
