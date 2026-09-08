import { useState } from "react";
import {
  IdentityLinkConsent,
  IdentityLinkAccounts,
  type IdentityLinkClient,
  type IdentityLinkAccountsClient,
} from "@opengeni/react/connect";
import "@opengeni/react/connect.css";
import { request } from "@/api";
import { ProblemPanel } from "@/components/common";
import { ContentPage } from "@/components/ui/content-layout";
import { useAppContext } from "@/context";
import { readIdentityLinkContinuation } from "@/lib/identity-link-continuation";

const path = (workspaceId: string, linkId: string) =>
  `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links/${encodeURIComponent(linkId)}`;
const client: IdentityLinkClient & IdentityLinkAccountsClient = {
  listIdentityLinks: (workspaceId, cursor) =>
    request(
      `/v1/workspaces/${encodeURIComponent(workspaceId)}/identity-links${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),
  previewIdentityLink: (workspaceId, linkId, challenge) =>
    request(`${path(workspaceId, linkId)}/preview`, {
      method: "POST",
      body: JSON.stringify({ challenge }),
    }),
  confirmIdentityLink: (workspaceId, linkId, input) =>
    request(`${path(workspaceId, linkId)}/confirm`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeIdentityLink: (workspaceId, linkId, expectedRevision) =>
    request(`${path(workspaceId, linkId)}/revoke`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision }),
    }),
};

export function NativeIdentityLinkAccounts({ workspaceId }: { workspaceId: string }) {
  const context = useAppContext();
  if (
    !context.managedSelfContext ||
    context.managedSelfContext.identity.subjectId !== context.accessContext.subjectId
  )
    return null;
  return (
    <IdentityLinkAccounts
      key={`${context.managedSelfContext.identity.credentialGeneration}:${context.accessContext.subjectId}`}
      client={client}
      workspaceId={workspaceId}
    />
  );
}

export function IdentityLinkRoute({
  linkId,
  organizationId,
}: {
  linkId: string;
  organizationId?: string;
}) {
  const context = useAppContext();
  const [challenge] = useState(() => readIdentityLinkContinuation(linkId, organizationId) ?? "");
  const workspace = context.workspaces.find((value) => value.accountId === organizationId);
  if (!/^[A-Za-z0-9_-]{43}$/.test(challenge))
    return (
      <ProblemPanel
        title="Link request unavailable"
        description="Reopen the account-link request from your product. Requests can only be confirmed for a short time."
      />
    );
  if (!workspace)
    return (
      <ProblemPanel
        title="Organization access required"
        description="Sign in to the OpenGeni account that belongs to the requesting organization, then reopen this request."
      />
    );
  return (
    <ContentPage>
      <IdentityLinkConsent
        key={`${context.accessContext.subjectId}:${linkId}`}
        client={client}
        workspaceId={workspace.id}
        linkId={linkId}
        challenge={challenge}
      />
    </ContentPage>
  );
}
