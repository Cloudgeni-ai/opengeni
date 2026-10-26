import { SubscriptionAccountIndicator } from "@opengeni/react/app/components/session/subscription-account-indicator";
import { WORKSPACE_ID } from "../../../../../packages/react/test/fake-client";
import type { PreviewProvider } from "./data";

export const SESSION_ID = "33333333-3333-4333-8333-333333333333";

/** The account control exactly as the session shell mounts it. */
export function AccountSlot({ provider }: { provider: PreviewProvider }) {
  return (
    <SubscriptionAccountIndicator
      workspaceId={WORKSPACE_ID}
      sessionId={SESSION_ID}
      organizationId="acme"
      provider={provider}
      events={[]}
    />
  );
}
