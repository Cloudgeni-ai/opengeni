import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { UpdateSidebarLayoutRequest, type AccessGrant } from "@opengeni/contracts";
import {
  readSidebarLayoutForGrant,
  updateSidebarLayoutForGrant,
  type ApiRouteDeps,
} from "@opengeni/core";
import { contractToolInput } from "./contract-input";

type JsonResult = (value: unknown) => {
  content: Array<{ type: "text"; text: string }>;
};

/**
 * Agents read and change the sidebar like any other setting
 * (docs/sidebar-layout.md): a person's own sidebar through these tools, and
 * the workspace default when the agent holds workspace admin; otherwise the
 * same change runs as the person through admin_action_call.
 */
export function registerSidebarLayoutTools(
  server: McpServer,
  deps: ApiRouteDeps,
  grant: AccessGrant,
  json: JsonResult,
): void {
  server.registerTool(
    "sidebar_layout_get",
    {
      description:
        "Show the sidebar (the navigation links and groups in the left rail) as the person sees it: groups, app links (optionally to a page inside the app), outside https links and live lists such as pinned or recent apps, with each item's id and whether it comes from the default everyone starts with or is their own. Also lists default items they hid and each scope's revision. Use it before sidebar_layout_update to find item ids.",
      inputSchema: {},
    },
    async () => json(await readSidebarLayoutForGrant(deps, grant)),
  );
  server.registerTool(
    "sidebar_layout_update",
    {
      description:
        "Change the sidebar with a list of changes applied together. scope personal changes only this person's sidebar: add items, remove (hides a workspace item, deletes their own), show a hidden item, move to reorder, update their own items, or reset to the workspace default. scope workspace changes everyone's default and needs workspace admin; when you lack it, run the same request as the person with admin_action_call (action 'PATCH /v1/workspaces/:workspaceId/sidebar-layout'). An app link takes the app's id and an optional page path such as /releases; outside links must be https. Groups hold links and lists but not other groups. Omit an item's id to have one made; pass expectedRevision from sidebar_layout_get to refuse a concurrent change instead of applying on top of it.",
      inputSchema: contractToolInput(UpdateSidebarLayoutRequest),
    },
    async (args) =>
      json(await updateSidebarLayoutForGrant(deps, grant, UpdateSidebarLayoutRequest.parse(args))),
  );
}
