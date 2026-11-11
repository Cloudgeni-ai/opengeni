import { OpenGeniClient } from "@opengeni/sdk";

// One-time demo setup: a workspace for the demo tenant and two members who may
// attach the per-session tool server. `bun run setup` prints the workspace id.
const og = new OpenGeniClient({
  baseUrl: process.env.OPENGENI_API_BASE_URL!,
  apiKey: process.env.OPENGENI_API_KEY!,
});
const source = "tool-server-demo";
const { workspace } = await og.ensureWorkspace({
  accountId: process.env.OPENGENI_ORGANIZATION_ID!,
  externalSource: source,
  externalId: "demo-tenant",
  name: "Tool server demo",
});
for (const user of ["ada", "grace"]) {
  await og.addExternalWorkspaceMember(workspace.id, {
    identity: { externalId: user, source },
    permissions: [
      "workspace:read",
      "sessions:create",
      "sessions:read",
      "sessions:control",
      "mcp_servers:attach", // required for the per-session tool server
    ],
    operationId: crypto.randomUUID(),
  });
}
console.log(`OPENGENI_WORKSPACE_ID=${workspace.id}`);
