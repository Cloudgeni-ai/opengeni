import { useNavigate } from "@tanstack/react-router";
import { PencilIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import {
  COMPANY_PROFILE_SCALAR_MAX_CHARS,
  type CompanyProfileContent,
  type CompanyProfileHead,
} from "@opengeni/sdk";
import { RowButton } from "@opengeni/react/ui/page-actions";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { ErrorMessage } from "@opengeni/react/ui/error-message";
import { Field, FieldStack, TextArea } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { Notice } from "@opengeni/react/ui/notice";
import { Section, SectionStack } from "@opengeni/react/ui/section";
import { SettingNavRow, SettingRowGroup, SettingRowSkeleton } from "@opengeni/react/ui/setting-row";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  AGENT_LEARNING_TITLE,
  IDENTITY_POLICY_MODE,
  LEARNING_MODE_LABEL,
} from "@opengeni/react/app/lib/agent-learning-vocabulary";
import {
  apiErrorFacts,
  apiErrorDetails,
  isPermissionDenied,
  userFacingError,
  userErrorTextWithoutReference,
} from "@opengeni/react/ui/api-error";
import { OrganizationKnowledgePrompt } from "@/routes/organization-knowledge-prompt";
import { useCompanyProfileInventory } from "@/routes/workspace-state-loader";
import type { CompanyProfileAgentPolicy } from "@opengeni/react/app/types";

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
                to: "/workspaces/$workspaceId/settings",
                params: { workspaceId },
                search: { section: "learning" },
              })
            }
          />
        </SettingRowGroup>
      )}
    </Section>
  );
}

const IDENTITY_LIMIT = COMPANY_PROFILE_SCALAR_MAX_CHARS.toLocaleString("en-US");

/** One field's text as the profile stores it: trimmed, and empty means unset. */
function profileText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * An owner writes the identity and mission by hand. The older compatibility
 * details are kept as they are; only the two fields change.
 */
export function EditIdentityDialog({
  open,
  onOpenChange,
  workspaceId,
  profile,
  head,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  workspaceId: string;
  /** The active profile, or null before the first one. */
  profile: CompanyProfileContent | null;
  /** The active revision the edit replaces, or null before the first one. */
  head: CompanyProfileHead | null;
  /** Reloads the identity after a save or after it changed underneath. */
  onSaved: () => Promise<void>;
}) {
  const client = useAppContext().client;
  const [identity, setIdentity] = useState("");
  const [mission, setMission] = useState("");
  // One logical save per text: retrying after an unclear outcome reuses the
  // operation, so the server applies it at most once.
  const operation = useRef<{ key: string; id: string } | null>(null);
  useEffect(() => {
    if (!open) return;
    setIdentity(profile?.identity ?? "");
    setMission(profile?.mission ?? "");
    operation.current = null;
    // Seed once per opening; a reload while open keeps what the owner typed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const nextIdentity = profileText(identity);
  const nextMission = profileText(mission);
  const unchanged =
    nextIdentity === (profile?.identity ?? null) && nextMission === (profile?.mission ?? null);
  const hasOtherDetails = profile
    ? profile.products.length +
        profile.customers.length +
        profile.goals.length +
        profile.constraints.length >
      0
    : false;
  const empty = nextIdentity === null && nextMission === null && !hasOtherDetails;
  const identityTooLong = identity.trim().length > COMPANY_PROFILE_SCALAR_MAX_CHARS;
  const missionTooLong = mission.trim().length > COMPANY_PROFILE_SCALAR_MAX_CHARS;
  const tooLongText = `Keep it under ${IDENTITY_LIMIT} characters.`;

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      title={
        profile?.identity || profile?.mission
          ? "Edit identity and mission"
          : "Write identity and mission"
      }
      description="Every top-level agent reads this in every chat, so keep each to a few sentences."
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={unchanged || empty || identityTooLong || missionTooLong}
      onSubmit={async () => {
        const next: CompanyProfileContent = {
          identity: nextIdentity,
          mission: nextMission,
          products: profile?.products ?? [],
          customers: profile?.customers ?? [],
          goals: profile?.goals ?? [],
          constraints: profile?.constraints ?? [],
        };
        const key = JSON.stringify([head?.revisionId ?? null, next.identity, next.mission]);
        if (operation.current?.key !== key) {
          operation.current = { key, id: crypto.randomUUID() };
        }
        try {
          await client.updateCompanyProfile(workspaceId, {
            operationId: operation.current.id,
            profile: next,
            expectedCurrentRevisionId: head?.revisionId ?? null,
            expectedActivationVersion: head?.activationVersion ?? 0,
            reason: "Edited in organization settings",
          });
        } catch (error) {
          if (apiErrorFacts(error).status === 409) {
            // Someone saved first. Load their version so Save replaces it on purpose.
            await onSaved();
            throw userFacingError(
              error,
              "The identity changed while you were editing. Your text is still here. Save again to replace the new version.",
            );
          }
          throw error;
        }
        await onSaved();
        toast.success("Saved. New chats use the updated identity.");
        return true;
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <FieldStack>
        <Field
          label="Who we are"
          error={identityTooLong ? tooLongText : undefined}
          aside={
            identityTooLong
              ? `${identity.trim().length.toLocaleString("en-US")} / ${IDENTITY_LIMIT}`
              : undefined
          }
        >
          <TextArea
            name="organization-identity"
            rows={4}
            value={identity}
            placeholder="For example: a small team building tools for independent bakeries."
            onChange={(event) => setIdentity(event.target.value)}
          />
        </Field>
        <Field
          label="Why we exist"
          error={missionTooLong ? tooLongText : undefined}
          aside={
            missionTooLong
              ? `${mission.trim().length.toLocaleString("en-US")} / ${IDENTITY_LIMIT}`
              : undefined
          }
        >
          <TextArea
            name="organization-mission"
            rows={4}
            value={mission}
            placeholder="For example: so good local bakeries can compete with the chains."
            onChange={(event) => setMission(event.target.value)}
          />
        </Field>
      </FieldStack>
    </FormDialog>
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
  const [editOpen, setEditOpen] = useState(false);
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
            ? "Write it yourself, or describe the organization below and Opengeni drafts a short version for you to check."
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
      action={
        canManage && inventory.response ? (
          <RowButton onClick={() => setEditOpen(true)}>
            <PencilIcon aria-hidden="true" />
            {profile ? "Edit" : "Write it yourself"}
          </RowButton>
        ) : undefined
      }
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
      {canManage && inventory.response ? (
        <EditIdentityDialog
          open={editOpen}
          onOpenChange={setEditOpen}
          workspaceId={workspaceId}
          profile={storedProfile}
          head={inventory.response.current}
          onSaved={inventory.reload}
        />
      ) : null}
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
