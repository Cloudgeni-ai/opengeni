import { onboardChatUser, openGeniFromEnvironment } from "./quickstart";

// Explicit onboarding for one demo user: `bun run onboard <user> [operation-id]`.
const [user, operationId = crypto.randomUUID()] = process.argv.slice(2);
if (!user) {
  console.error("Usage: bun run onboard <user> [operation-id]");
  process.exit(1);
}
const { og, tenant } = openGeniFromEnvironment();
// Printed before the call so an uncertain result can be retried with the same id.
console.log(`Onboarding ${user} to tenant ${tenant} with operation ${operationId}`);
const workspaceId = await onboardChatUser(og, { tenant, user, operationId });
console.log(`${user} can now chat in workspace ${workspaceId}`);
