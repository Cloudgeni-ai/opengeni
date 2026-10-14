import type { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import {
  getOrganizationPrivateSessionSettings,
  updateOrganizationPrivateSessionSettings,
} from "@opengeni/sdk/organization-private-session-settings";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

import { RowButton } from "@/components/ui/page-actions";
import { OrganizationRecoverySection } from "@/components/organization-recovery";
import { ErrorMessage } from "@/components/ui/error-message";
import { FormDialog } from "@/components/ui/form-dialog";
import { MetaChip } from "@/components/ui/meta-chip";
import { Notice } from "@/components/ui/notice";
import { Section, SectionStack } from "@/components/ui/section";
import { SelectMenu } from "@/components/ui/select-menu";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SettingRow, SettingRowGroup, SettingRowSkeleton } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";
import {
  apiErrorDetails,
  isPermissionDenied,
  userErrorText,
  userErrorTextWithoutReference,
} from "@/lib/api-error";
import {
  beginOrganizationAdminOperation,
  isOrganizationConflict,
  organizationAdminIdentityKey,
  ownsOrganizationAdminOperation,
  validRetentionDays,
  type OrganizationAdminIdentity,
  type OrganizationAdminOperation,
  type OrganizationAdminOperationLane,
  type OrganizationAdminResource,
} from "@/lib/organization-admin";
import type {
  OrganizationPrivacySettings,
  OrganizationPrivateSessionSettings,
  OrganizationRetentionPolicy,
} from "@/types";

import { useOrganizationDirectory } from "./organization-directory";

/* ----------------------------------------------------------------------------
   Organization settings > Security & data: Only me chats and schedules, admin access for
   agent sessions, how long a removed person's data is kept, and recovery
   (owners, managed sign-in only).
   -------------------------------------------------------------------------- */

export function OrganizationSecurityPage() {
  const directory = useOrganizationDirectory();
  const client = useAppContext().client;
  const managedPeople = directory.managedSession && !directory.singleUser;
  // Members see only Recovery: they may be recovery contacts.
  const administrator = directory.canAdminister;
  return (
    <SectionStack>
      {managedPeople && administrator ? (
        <Section title="Chats and schedules">
          <PrivateChatsRow client={client} identity={directory.identity} />
        </Section>
      ) : null}
      {administrator ? (
        <Section title="Agents">
          <AgentAdminAccessRow client={client} identity={directory.identity} />
        </Section>
      ) : null}
      {administrator ? (
        <Section
          title="Retention"
          description="How long a removed person's personal data is kept. Their access always ends right away."
        >
          <RetentionRow
            client={client}
            identity={directory.identity}
            canEdit={directory.actorRole === "owner"}
          />
        </Section>
      ) : null}
      {managedPeople ? (
        <Section
          title={
            administrator ? (
              <span className="inline-flex items-center gap-2">
                Recovery <MetaChip variant="outline">Owners only</MetaChip>
              </span>
            ) : (
              "Recovery"
            )
          }
          description="If every owner loses access, recovery contacts can make another member an owner."
        >
          <OrganizationRecoverySection
            key={organizationAdminIdentityKey(directory.identity)}
            client={client}
            identity={directory.identity}
            managedSession
          />
        </Section>
      ) : null}
    </SectionStack>
  );
}

/** A read or write that is dropped when the identity or a newer request moved on. */
function useOwnedOperations(
  identity: OrganizationAdminIdentity,
  resource: OrganizationAdminResource,
) {
  const identityRef = useRef<OrganizationAdminIdentity | null>(identity);
  identityRef.current = identity;
  const sequenceRef = useRef(new Map<OrganizationAdminOperationLane, number>());
  const activeRef = useRef(new Map<OrganizationAdminOperationLane, OrganizationAdminOperation>());
  useEffect(() => {
    const active = activeRef.current;
    identityRef.current = identity;
    return () => {
      identityRef.current = null;
      active.clear();
    };
  }, [identity]);
  const claim = useCallback(
    (lane: OrganizationAdminOperationLane) => {
      const operation = beginOrganizationAdminOperation({
        identity,
        resource,
        lane,
        previousSequence: sequenceRef.current.get(lane) ?? 0,
      });
      sequenceRef.current.set(lane, operation.sequence);
      activeRef.current.set(lane, operation);
      return operation;
    },
    [identity, resource],
  );
  const owns = useCallback(
    (operation: OrganizationAdminOperation) =>
      ownsOrganizationAdminOperation({
        currentIdentity: identityRef.current,
        currentOperation: activeRef.current.get(operation.lane) ?? null,
        accepted: operation,
      }),
    [],
  );
  return { claim, owns };
}

/**
 * A setting that didn't load: calm and without Try again when the viewer lacks
 * the permission, otherwise what happened and what to do.
 */
function RowLoadFailure({
  title,
  error,
  onRetry,
}: {
  title: string;
  error: Error;
  onRetry: () => void;
}) {
  if (isPermissionDenied(error)) {
    return <Notice title="You can't see this setting.">Ask an organization owner.</Notice>;
  }
  return (
    <ErrorMessage
      variant="inline"
      title={title}
      action={<RowButton onClick={onRetry}>Try again</RowButton>}
      {...apiErrorDetails(error)}
    >
      {userErrorTextWithoutReference(error)}
    </ErrorMessage>
  );
}

/* ----------------------------------------------- Only me chats and schedules */

type PrivacyChoice = Partial<
  Pick<OrganizationPrivacySettings, "defaultVisibility" | "adminsSeePrivateSchedules">
>;

/** What a row says when this app fixes the choice for every organization. */
const LOCKED_FOR_APP = "This is set for everyone using this app.";

export function PrivateChatsRow({
  client,
  identity,
}: {
  client: OpenGeniBrowserClient;
  identity: OrganizationAdminIdentity;
}) {
  const { claim, owns } = useOwnedOperations(identity, "private-sessions");
  const { claim: claimPrivacy, owns: ownsPrivacy } = useOwnedOperations(identity, "privacy");
  const [settings, setSettings] = useState<OrganizationPrivateSessionSettings | null>(null);
  const [privacy, setPrivacy] = useState<OrganizationPrivacySettings | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [privacyPending, setPrivacyPending] = useState<PrivacyChoice | null>(null);

  const load = useCallback(async () => {
    const operation = claim("read");
    const privacyOperation = claimPrivacy("read");
    setError(null);
    try {
      const [value, privacyValue] = await Promise.all([
        getOrganizationPrivateSessionSettings(client, identity.organizationId),
        client.getOrganizationPrivacySettings(identity.organizationId),
      ]);
      if (owns(operation)) setSettings(value);
      if (ownsPrivacy(privacyOperation)) setPrivacy(privacyValue);
    } catch (loadError) {
      if (owns(operation))
        setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    }
  }, [claim, claimPrivacy, client, identity.organizationId, owns, ownsPrivacy]);

  useEffect(() => {
    void load();
  }, [load]);

  const savePrivacy = useCallback(
    async (change: PrivacyChoice, success: string) => {
      const operation = claimPrivacy("mutation");
      setPrivacyPending(change);
      try {
        const value = await client.updateOrganizationPrivacySettings(
          identity.organizationId,
          change,
        );
        if (!ownsPrivacy(operation)) return;
        setPrivacy(value);
        toast.success(success);
      } catch (saveError) {
        if (!ownsPrivacy(operation)) return;
        toast.error("Couldn't change this setting", { description: userErrorText(saveError) });
      } finally {
        if (ownsPrivacy(operation)) setPrivacyPending(null);
      }
    },
    [claimPrivacy, client, identity.organizationId, ownsPrivacy],
  );

  if (error && (!settings || !privacy)) {
    return (
      <RowLoadFailure
        title="Couldn't load these settings."
        error={error}
        onRetry={() => void load()}
      />
    );
  }
  if (!settings || !privacy) return <SettingRowSkeleton />;

  const available = settings.available && privacy.limits.onlyMeAllowed;
  const enabled = available && (pending ?? settings.enabled);
  const defaultVisibility = privacyPending?.defaultVisibility ?? privacy.defaultVisibility;
  const adminsSee = privacyPending?.adminsSeePrivateSchedules ?? privacy.adminsSeePrivateSchedules;

  return (
    <SettingRowGroup>
      <SettingRow
        label="Only me chats and schedules"
        description={
          available
            ? "Lets people start chats and schedules only they can see in shared workspaces. Personal workspaces are always private."
            : `Only me is off. ${LOCKED_FOR_APP}`
        }
        control={
          <Switch
            aria-label="Only me chats and schedules"
            checked={enabled}
            pending={pending !== null}
            disabled={!available}
            onCheckedChange={async (next) => {
              const operation = claim("mutation");
              setPending(next);
              try {
                const value = await updateOrganizationPrivateSessionSettings(
                  client,
                  identity.organizationId,
                  {
                    enabled: next,
                    expectedVersion: settings.version,
                    operationId: crypto.randomUUID(),
                  },
                );
                if (!owns(operation)) return;
                setSettings(value);
                toast.success(
                  next
                    ? "People can start Only me chats and schedules"
                    : "Only me is off for new chats and schedules",
                );
              } catch (saveError) {
                if (!owns(operation)) return;
                if (isOrganizationConflict(saveError)) await load();
                toast.error("Couldn't change Only me", {
                  description: userErrorText(saveError),
                });
              } finally {
                if (owns(operation)) setPending(null);
              }
            }}
          />
        }
      >
        {enabled ? (
          <SettingRow
            label="New chats and schedules"
            description={
              privacy.limits.defaultVisibilityLocked
                ? `Start as Workspace. ${LOCKED_FOR_APP}`
                : "Who can see them, unless the person picks otherwise."
            }
            controlWidth="auto"
            control={
              <SegmentedControl<"workspace" | "private">
                size="sm"
                aria-label="Who can see new chats and schedules"
                value={defaultVisibility}
                onValueChange={(next) => {
                  if (next === defaultVisibility) return;
                  void savePrivacy(
                    { defaultVisibility: next },
                    next === "private"
                      ? "New chats and schedules start as Only me"
                      : "New chats and schedules start as Workspace",
                  );
                }}
                options={[
                  { value: "workspace", label: "Workspace" },
                  { value: "private", label: "Only me" },
                ].map((option) => ({
                  ...(option as { value: "workspace" | "private"; label: string }),
                  disabled: privacyPending !== null || privacy.limits.defaultVisibilityLocked,
                  ...(privacy.limits.defaultVisibilityLocked
                    ? { disabledReason: LOCKED_FOR_APP }
                    : {}),
                }))}
              />
            }
          />
        ) : null}
      </SettingRow>
      <SettingRow
        label="Admins see Only me schedules"
        description={
          privacy.limits.adminsSeePrivateSchedulesLocked
            ? `Admins see who owns each one, how often it runs and what it costs, and can pause it. ${LOCKED_FOR_APP}`
            : adminsSee
              ? "Admins see who owns each one, how often it runs and what it costs, and can pause it. Never its name, message or chats."
              : "Admins can't see other people's Only me schedules at all, like Only me chats."
        }
        control={
          <Switch
            aria-label="Admins see Only me schedules"
            checked={adminsSee}
            pending={privacyPending?.adminsSeePrivateSchedules !== undefined}
            disabled={privacy.limits.adminsSeePrivateSchedulesLocked}
            onCheckedChange={(next) =>
              void savePrivacy(
                { adminsSeePrivateSchedules: next },
                next
                  ? "Admins see that Only me schedules exist"
                  : "Only me schedules are hidden from admins",
              )
            }
          />
        }
      />
    </SettingRowGroup>
  );
}

/* ------------------------------------------------- Admin access for agents */

export function AgentAdminAccessRow({
  client,
  identity,
}: {
  client: OpenGeniBrowserClient;
  identity: OrganizationAdminIdentity;
}) {
  const { claim, owns } = useOwnedOperations(identity, "agent-admin-access");
  const [allowed, setAllowed] = useState<boolean | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);
  const [confirmOff, setConfirmOff] = useState(false);

  const load = useCallback(async () => {
    const operation = claim("read");
    setError(null);
    try {
      const value = await client.getOrganizationAgentAdminAccess(identity.organizationId);
      if (owns(operation)) setAllowed(value.sessionAdminAccessAllowed);
    } catch (loadError) {
      if (owns(operation))
        setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    }
  }, [claim, client, identity.organizationId, owns]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = useCallback(
    async (next: boolean) => {
      const operation = claim("mutation");
      setPending(next);
      try {
        const value = await client.updateOrganizationAgentAdminAccess(identity.organizationId, {
          sessionAdminAccessAllowed: next,
        });
        if (!owns(operation)) return;
        setAllowed(value.sessionAdminAccessAllowed);
        toast.success(
          next
            ? "Owners and admins can give their sessions admin access"
            : "Admin access is off for every session",
        );
      } catch (saveError) {
        if (!owns(operation)) return;
        toast.error("Couldn't change admin access for agents", {
          description: userErrorText(saveError),
        });
      } finally {
        if (owns(operation)) setPending(null);
      }
    },
    [claim, client, identity.organizationId, owns],
  );

  if (error && allowed === null) {
    return (
      <RowLoadFailure
        title="Couldn't load the admin access setting."
        error={error}
        onRetry={() => void load()}
      />
    );
  }
  if (allowed === null) return <SettingRowSkeleton />;

  return (
    <SettingRowGroup>
      <SettingRow
        label="Admin access for agent sessions"
        description="Lets owners and admins give one of their own sessions admin access. Its agent can then manage what they can across the organization: every workspace's sessions, settings and connections."
        control={
          <Switch
            aria-label="Admin access for agent sessions"
            checked={pending ?? allowed}
            pending={pending !== null}
            onCheckedChange={(next) => {
              if (next) void save(true);
              else setConfirmOff(true);
            }}
          />
        }
      />
      <FormDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        size="sm"
        title="Turn off admin access for agents?"
        description="Every session that has admin access loses it right away. Turning this on again doesn't give it back."
        submitLabel="Turn off"
        pendingLabel="Turning off…"
        tone="destructive"
        initialFocus="cancel"
        onSubmit={async () => {
          await save(false);
        }}
        onSubmitted={() => setConfirmOff(false)}
      />
    </SettingRowGroup>
  );
}

/* --------------------------------------------------------------- Retention */

type RetentionChoice = "retain" | `${number}`;

function choiceOf(policy: OrganizationRetentionPolicy): RetentionChoice {
  return policy.mode === "retain" ? "retain" : `${policy.retentionDays ?? 30}`;
}

function retentionSentence(choice: RetentionChoice): string {
  return choice === "retain"
    ? "Kept until someone who runs your Opengeni deletes it."
    : `Deleted ${choice} days after the person is removed.`;
}

function RetentionRow({
  client,
  identity,
  canEdit,
}: {
  client: OpenGeniBrowserClient;
  identity: OrganizationAdminIdentity;
  canEdit: boolean;
}) {
  const { claim, owns } = useOwnedOperations(identity, "retention");
  const [policy, setPolicy] = useState<OrganizationRetentionPolicy | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [draft, setDraft] = useState<RetentionChoice | null>(null);

  const load = useCallback(async () => {
    const operation = claim("read");
    setError(null);
    try {
      const value = await client.getOrganizationRetentionPolicy(identity.organizationId);
      if (owns(operation)) setPolicy(value);
    } catch (loadError) {
      if (owns(operation))
        setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    }
  }, [claim, client, identity.organizationId, owns]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !policy) {
    return (
      <RowLoadFailure
        title="Couldn't load the retention policy."
        error={error}
        onRetry={() => void load()}
      />
    );
  }
  if (!policy) return <SettingRowSkeleton />;

  const current = choiceOf(policy);
  const options: { value: RetentionChoice; label: string }[] = [
    { value: "retain", label: "Until deleted by hand" },
    { value: "30", label: "30 days" },
    { value: "60", label: "60 days" },
    { value: "90", label: "90 days" },
  ];
  if (!options.some((option) => option.value === current)) {
    options.splice(1, 0, { value: current, label: `${current} days` });
  }

  return (
    <SettingRowGroup>
      <SettingRow
        label="Keep a removed person's data"
        description={retentionSentence(current)}
        controlWidth="select"
        control={
          <SelectMenu<RetentionChoice>
            size="sm"
            aria-label="Keep a removed person's data"
            value={current}
            options={options}
            disabled={!canEdit}
            disabledReason={canEdit ? undefined : "Only owners can change this."}
            onValueChange={(value) => {
              if (value !== current) setDraft(value);
            }}
            className="w-full"
          />
        }
      />
      <FormDialog
        open={draft !== null}
        onOpenChange={(open) => {
          if (!open) setDraft(null);
        }}
        size="sm"
        title="Change how long removed people's data is kept?"
        description={
          draft === "retain"
            ? "Their personal data is kept until someone who runs your Opengeni deletes it. This doesn't give back any access."
            : `Their personal data becomes eligible for deletion ${draft} days after they're removed. Access still ends right away.`
        }
        submitLabel="Change retention"
        pendingLabel="Saving…"
        tone={draft === "retain" ? "default" : "destructive"}
        initialFocus="cancel"
        onSubmit={async () => {
          if (!draft) return false;
          const retentionDays = draft === "retain" ? null : Number(draft);
          if (retentionDays !== null && !validRetentionDays(retentionDays)) {
            throw new Error("Pick between 30 and 90 days.");
          }
          const operation = claim("mutation");
          try {
            const updated = await client.updateOrganizationRetentionPolicy(
              identity.organizationId,
              {
                mode: draft === "retain" ? "retain" : "delete_after",
                retentionDays,
                expectedVersion: policy.version,
                operationId: crypto.randomUUID(),
              },
            );
            if (owns(operation)) setPolicy(updated);
            toast.success("Saved the retention policy");
          } catch (saveError) {
            if (isOrganizationConflict(saveError)) {
              await load();
              throw new Error("Someone else changed this policy. Check it and try again.", {
                cause: saveError,
              });
            }
            throw saveError;
          }
        }}
        onSubmitted={() => setDraft(null)}
      />
    </SettingRowGroup>
  );
}
