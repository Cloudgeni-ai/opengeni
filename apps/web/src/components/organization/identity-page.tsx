import { useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";

import { RowButton } from "@/components/ui/page-actions";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { EmptyState } from "@/components/ui/empty-state";
import { ErrorMessage } from "@/components/ui/error-message";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingNavRow, SettingRowGroup, SettingRowSkeleton } from "@/components/ui/setting-row";
import { useAppContext } from "@/context";
import { apiErrorDetails, isPermissionDenied, userErrorText } from "@/lib/api-error";
import { OrganizationKnowledgePrompt } from "@/routes/organization-knowledge-prompt";
import { useCompanyProfileInventory } from "@/routes/workspace-state-loader";
import type { CompanyProfileAgentPolicy, CompanyProfileAgentPolicyMode } from "@/types";

/* ----------------------------------------------------------------------------
   Organization settings > Organization identity: the small identity and
   mission every agent knows, whether agents may change it, and where the rest
   of the organization's knowledge lives.
   -------------------------------------------------------------------------- */

const AGENT_MODES: Record<CompanyProfileAgentPolicyMode, { label: string; description: string }> = {
  off: {
    label: "Off",
    description: "Agents can't propose changes to the identity.",
  },
  suggest: {
    label: "Require approval",
    description: "An agent drafts the change and the owner who asked approves it.",
  },
  automatic: {
    label: "Automatic",
    description: "A change an owner asks for in a live chat applies without another prompt.",
  },
};

const MODE_ORDER: CompanyProfileAgentPolicyMode[] = ["off", "suggest", "automatic"];

function savedMessage(mode: CompanyProfileAgentPolicyMode): string {
  if (mode === "automatic") return "Agents can now apply identity changes an owner asks for.";
  if (mode === "suggest") return "Identity changes from agents now need an owner's approval.";
  return "Agents can no longer change the identity.";
}

function AgentChangesSection({ workspaceId }: { workspaceId: string }) {
  const client = useAppContext().client;
  const [policy, setPolicy] = useState<CompanyProfileAgentPolicy | null>(null);
  const [mode, setMode] = useState<CompanyProfileAgentPolicyMode>("suggest");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<Error | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const value = await client.getCompanyProfileAgentPolicy(workspaceId);
      setPolicy(value);
      setMode(value.mode);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    } finally {
      setLoading(false);
    }
  }, [client, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async (nextMode: CompanyProfileAgentPolicyMode): Promise<void> => {
    if (!policy || saving || nextMode === mode) return;
    setMode(nextMode);
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const value = await client.updateCompanyProfileAgentPolicy(workspaceId, {
        mode: nextMode,
        expectedVersion: policy.version,
        operationId: crypto.randomUUID(),
      });
      setPolicy(value);
      setMode(value.mode);
      setMessage(savedMessage(value.mode));
    } catch (saveError) {
      setMode(policy.mode);
      setError(saveError instanceof Error ? saveError : new Error(String(saveError)));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Section
      title="Agent changes"
      description="Whether agents may update the identity. Only a live chat started by an organization owner can."
    >
      <div className="mt-1 flex min-w-0 flex-col gap-3">
        {error && !policy ? (
          <ErrorMessage
            variant="block"
            title="Couldn't load whether agents can change the identity."
            announce
            action={<RowButton onClick={() => void load()}>Try again</RowButton>}
            {...apiErrorDetails(error)}
          >
            {userErrorText(error)}
          </ErrorMessage>
        ) : loading || !policy ? (
          <div role="status" aria-label="Loading agent changes…">
            <SettingRowSkeleton />
          </div>
        ) : (
          <>
            <ChoiceCards
              aria-label="Agent-managed organization identity mode"
              name="company-profile-agent-policy"
              value={mode}
              disabled={saving}
              onValueChange={(value) => void save(value as CompanyProfileAgentPolicyMode)}
            >
              {MODE_ORDER.map((candidate) => (
                <ChoiceCard
                  key={candidate}
                  value={candidate}
                  title={AGENT_MODES[candidate].label}
                  description={AGENT_MODES[candidate].description}
                />
              ))}
            </ChoiceCards>
            {mode === "automatic" ? (
              <Notice tone="waiting">
                This applies to the whole organization. Each change still has to come from a current
                owner, and applies to new agent runs only.
              </Notice>
            ) : null}
            {error ? (
              <ErrorMessage
                variant="inline"
                title="Couldn't save that."
                announce
                {...apiErrorDetails(error)}
              >
                {userErrorText(error)}
              </ErrorMessage>
            ) : null}
            <p role="status" className="text-xs leading-[18px] text-fg-muted empty:hidden">
              {saving ? "Saving…" : (message ?? "")}
            </p>
          </>
        )}
      </div>
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
        {userErrorText(inventory.error)}
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
            {userErrorText(inventory.error)}
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
              Agent-managed organization identity is owner-only. Ask an organization owner to change
              this mode.
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
                to: "/workspaces/$workspaceId/documents",
                params: { workspaceId },
                search: { authority: "organization" },
              })
            }
          />
        </SettingRowGroup>
      </Section>
    </SectionStack>
  );
}
