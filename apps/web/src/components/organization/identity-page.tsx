import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { RowButton } from "@/components/ui/page-actions";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingNavRow, SettingRowGroup, SettingRowSkeleton } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import {
  AGENT_LEARNING_TITLE,
  IDENTITY_POLICY_MODE,
  LEARNING_MODE_LABEL,
} from "@/lib/agent-learning-vocabulary";
import {
  apiErrorDetails,
  isPermissionDenied,
  userErrorTextWithoutReference,
} from "@/lib/api-error";
import { OrganizationKnowledgePrompt } from "@/routes/organization-knowledge-prompt";
import { useCompanyProfileInventory } from "@/routes/workspace-state-loader";
import type { CompanyProfileAgentPolicy } from "@/types";

/* ----------------------------------------------------------------------------
   Organization settings > Organization identity: the small identity and
   mission every agent knows, whether agents may change it, and where the rest
   of the organization's knowledge lives.
   -------------------------------------------------------------------------- */

/**
 * Whether agents may change the identity, as one line: the current Agent
 * learning mode, opening the Agent learning page where owners change it with
 * the workspace's other modes, in the same words.
 */
function AgentChangesSection({ workspaceId }: { workspaceId: string }) {
  const client = useAppContext().client;
  const navigate = useNavigate();
  const [policy, setPolicy] = useState<CompanyProfileAgentPolicy | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [retry, setRetry] = useState(0);
  const load = useCallback(() => setRetry((value) => value + 1), []);

  useEffect(() => {
    // A read for an earlier workspace (or retry) never overwrites a newer one.
    let current = true;
    setError(null);
    client
      .getCompanyProfileAgentPolicy(workspaceId)
      .then((value) => {
        if (current) setPolicy(value);
      })
      .catch((loadError: unknown) => {
        if (current) {
          setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
        }
      });
    return () => {
      current = false;
    };
  }, [client, workspaceId, retry]);

  return (
    <Section title="Agent changes">
      {error && !policy ? (
        <ErrorMessage
          variant="block"
          title="Couldn't load whether agents can change the identity."
          announce
          action={<RowButton onClick={load}>Try again</RowButton>}
          {...apiErrorDetails(error)}
        >
          {userErrorTextWithoutReference(error)}
        </ErrorMessage>
      ) : !policy ? (
        <div role="status" aria-label="Loading agent changes…">
          <SettingRowSkeleton />
        </div>
      ) : (
        <SettingRowGroup>
          <SettingNavRow
            label={AGENT_LEARNING_TITLE}
            description="Whether agents may update the identity when an owner asks in a chat. Set with the other Agent learning modes."
            value={LEARNING_MODE_LABEL[IDENTITY_POLICY_MODE[policy.mode]]}
            onOpen={() =>
              void navigate({
                to: "/workspaces/$workspaceId/state",
                params: { workspaceId },
                search: { page: "learning" },
              })
            }
          />
        </SettingRowGroup>
      )}
    </Section>
  );
}

function CurrentIdentitySection({
  workspaceId,
  canManage,
}: {
  workspaceId: string;
  canManage: boolean;
}) {
  const client = useAppContext().client;
  const inventory = useCompanyProfileInventory(client, workspaceId);
  const storedProfile = inventory.response?.activeRevision?.profile ?? null;
  const profile = storedProfile?.identity || storedProfile?.mission ? storedProfile : null;
  const legacyDetailCount = storedProfile
    ? storedProfile.products.length +
      storedProfile.customers.length +
      storedProfile.goals.length +
      storedProfile.constraints.length
    : 0;

  let body;
  if (inventory.loading && !inventory.response) {
    body = (
      <div role="status" aria-label="Loading organization identity…">
        <SettingRowSkeleton />
      </div>
    );
  } else if (inventory.error && !inventory.response && isPermissionDenied(inventory.error)) {
    body = (
      <Notice title="You can't see the organization identity.">
        Ask an organization owner or admin for access.
      </Notice>
    );
  } else if (inventory.error && !inventory.response) {
    body = (
      <ErrorMessage
        variant="block"
        title="Couldn't load the organization identity."
        announce
        action={<RowButton onClick={() => void inventory.reload()}>Try again</RowButton>}
        {...apiErrorDetails(inventory.error)}
      >
        {userErrorTextWithoutReference(inventory.error)}
      </ErrorMessage>
    );
  } else if (!profile) {
    body = (
      <EmptyState
        variant="inline"
        title="No identity yet."
        description={
          canManage
            ? "Describe the organization below and Opengeni drafts a short version for you to check."
            : "An organization owner can add one."
        }
      />
    );
  } else {
    body = (
      <dl className="m-0 flex min-w-0 flex-col gap-4">
        {profile.identity ? (
          <div className="min-w-0">
            <dt className="text-xs leading-[18px] text-fg-muted">Who we are</dt>
            <dd className="m-0 mt-1 text-sm leading-6 text-fg">{profile.identity}</dd>
          </div>
        ) : null}
        {profile.mission ? (
          <div className="min-w-0">
            <dt className="text-xs leading-[18px] text-fg-muted">Why we exist</dt>
            <dd className="m-0 mt-1 text-sm leading-6 text-fg">{profile.mission}</dd>
          </div>
        ) : null}
      </dl>
    );
  }

  return (
    <Section
      title="Identity and mission"
      description="Every top-level agent knows this, so keep it short and stable."
    >
      <div className="mt-1 flex min-w-0 flex-col gap-3">
        {body}
        {legacyDetailCount > 0 ? (
          <Notice tone="waiting">
            {legacyDetailCount} older {legacyDetailCount === 1 ? "detail is" : "details are"} still
            given to agents for compatibility.{" "}
            {canManage
              ? "Move them into organization Documents before replacing this identity."
              : "An owner can move them into organization Documents before replacing this identity."}
          </Notice>
        ) : null}
        {inventory.error && inventory.response ? (
          <ErrorMessage
            variant="inline"
            title="Couldn't refresh the identity."
            announce
            {...apiErrorDetails(inventory.error)}
          >
            {userErrorTextWithoutReference(inventory.error)}
          </ErrorMessage>
        ) : null}
      </div>
    </Section>
  );
}

export function OrganizationIdentityPage({
  workspaceId,
  identityKey,
  canManage,
  canManageAgentPolicy,
}: {
  workspaceId: string;
  identityKey: string;
  /** account:admin: owners edit the identity. */
  canManage: boolean;
  /** Owner-only: whether agents may change the identity. */
  canManageAgentPolicy: boolean;
}) {
  const navigate = useNavigate();
  return (
    <SectionStack>
      <CurrentIdentitySection workspaceId={workspaceId} canManage={canManage} />
      {canManage ? (
        // The request field is the card here: an open section keeps the
        // textarea from becoming a box inside a box.
        <Section
          variant="open"
          title="Write it with Opengeni"
          description="Opengeni keeps it to identity and mission, asks only what it needs, and shows you the result before saving."
        >
          <OrganizationKnowledgePrompt workspaceId={workspaceId} />
        </Section>
      ) : (
        <p className="text-xs leading-[18px] text-fg-muted">
          Organization identity is read-only for you. An organization owner can update it.
        </p>
      )}
      {canManage ? (
        canManageAgentPolicy ? (
          <AgentChangesSection
            key={`${identityKey}:company-profile-agent-policy`}
            workspaceId={workspaceId}
          />
        ) : (
          <Section title="Agent changes">
            <p className="text-xs leading-[18px] text-fg-muted">
              Only organization owners can change whether agents may update the identity. Ask an
              owner.
            </p>
          </Section>
        )
      ) : null}
      <Section title="Documents">
        <SettingRowGroup>
          <SettingNavRow
            label="Organization documents"
            description="Products, customers, goals and other facts that change. Agents look them up only when relevant."
            value="Open"
            onOpen={() =>
              void navigate({
                to: "/workspaces/$workspaceId/state",
                params: { workspaceId },
                search: { scope: "organization" },
              })
            }
          />
        </SettingRowGroup>
      </Section>
    </SectionStack>
  );
}
