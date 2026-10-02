// Explicit operator step, never a browser/proxy request or automatic membership repair.
import { OpenGeniClient } from "@opengeni/sdk";
import { required } from "./server";

const client = new OpenGeniClient({
  baseUrl: required("OPENGENI_API_BASE_URL"),
  apiKey: required("OPENGENI_API_KEY"),
});
const source = required("HOST_IDENTITY_SOURCE");
const { workspace } = await client.ensureWorkspace({
  accountId: required("OPENGENI_ORGANIZATION_ID"),
  externalSource: source,
  externalId: required("HOST_TENANT_ID"),
  name: "Harbor hotel",
});
await client.addExternalWorkspaceMember(workspace.id, {
  identity: { externalId: required("HOST_USER_ID"), source },
  permissions: ["workspace:read", "sessions:create", "sessions:read", "sessions:control"],
  operationId: required("OPENGENI_MEMBER_OPERATION_ID"),
});
console.log(
  `Set OPENGENI_WORKSPACE_ID=${workspace.id} in .env.local. Persist this tenant mapping in your host's database.`,
);
