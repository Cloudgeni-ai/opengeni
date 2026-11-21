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
        "Show the sidebar (the navigation links and groups in the left rail) as the person sees it: groups, app links (optionally to a page inside the app), agent links (to an agent's page), outside https links and live lists such as pinned or recent apps, with each item's id, icon and whether it comes from the default everyone starts with or is their own. Also lists default items they hid, each scope's revision, and the navigation options in effect (options: whether apps show as rows in the Sessions list, which built-in rail entries are hidden, which settings entries show at the top of the settings rail). Use it before sidebar_layout_update to find item ids.",
      inputSchema: {},
    },
    async () => json(await readSidebarLayoutForGrant(deps, grant)),
  );
  server.registerTool(
    "sidebar_layout_update",
    {
      description:
        "Change the sidebar with a list of changes applied together. scope personal changes only this person's sidebar: add items, remove (hides a workspace item, deletes their own), show a hidden item, move to reorder, update their own items (rename a group with label), or reset to the workspace default. scope workspace changes everyone's default and needs workspace admin; when you lack it, run the same request as the person with admin_action_call (action 'PATCH /v1/workspaces/:workspaceId/sidebar-layout'). An app link takes the app's id and an optional page path such as /releases; an agent link (type agent) takes the agent's id and shows its name and avatar, only to people who can see the agent; outside links must be https. Groups hold links and lists but not other groups. Place items with beforeId or afterId (a neighbouring item's id in the target level) rather than index; if several are given, beforeId wins, then afterId, then index, and none means the end. In personal changes, workspace items stay in their group. Omit an item's id to have one made. A person's own item ids always start with my-: a given id without it is prefixed (docs becomes my-docs), so use the ids in the answer for later changes; workspace ids can't start with my-. App links, outside links and groups take an optional icon, a lucide icon name from a fixed set (such as rocket, chart-line, book-open; update with icon null to remove it); an outside link without one shows its site's icon. The options change sets navigation options for the scope, each optional and null to clear (personal back to the default's, workspace back to today's behaviour): sessionsShowApps (false lists apps' chats as ordinary chats instead of app rows in the Sessions list), hiddenNavEntries (built-in rail entries to hide: inbox, capabilities, knowledge, automations, agents, meetings, artifacts) and settingsMore (settings rail entry ids such as workspace:general or organization:members moved under a collapsed More; the rest stay at the top). A recent_apps live list holds the apps the person opened or edited last; put one in a group (for example Apps) and update its label or limit like any item. Pass expectedRevision from sidebar_layout_get to refuse a concurrent change instead of applying on top of it.",
      inputSchema: contractToolInput(UpdateSidebarLayoutRequest),
    },
    async (args) =>
      json(await updateSidebarLayoutForGrant(deps, grant, UpdateSidebarLayoutRequest.parse(args))),
  );
}
