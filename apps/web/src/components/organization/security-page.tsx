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
import { SettingRow, SettingRowGroup, SettingRowSkeleton } from "@/components/ui/setting-row";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";
import { apiErrorDetails, isPermissionDenied, userErrorText } from "@/lib/api-error";
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
import type { OrganizationPrivateSessionSettings, OrganizationRetentionPolicy } from "@/types";

import { useOrganizationDirectory } from "./organization-directory";

/* ----------------------------------------------------------------------------
   Organization settings > Security & data: Only me chats, how long a removed
   person's data is kept, and recovery (owners, managed sign-in only).
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
        <Section title="Chats">
          <PrivateChatsRow client={client} identity={directory.identity} />
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
      {userErrorText(error)}
    </ErrorMessage>
  );
}

/* ------------------------------------------------------------ Only me chats */

function PrivateChatsRow({
  client,
  identity,
}: {
  client: OpenGeniBrowserClient;
  identity: OrganizationAdminIdentity;
}) {
  const { claim, owns } = useOwnedOperations(identity, "private-sessions");
  const [settings, setSettings] = useState<OrganizationPrivateSessionSettings | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [pending, setPending] = useState<boolean | null>(null);

  const load = useCallback(async () => {
    const operation = claim("read");
    setError(null);
    try {
      const value = await getOrganizationPrivateSessionSettings(client, identity.organizationId);
      if (owns(operation)) setSettings(value);
    } catch (loadError) {
      if (owns(operation))
        setError(loadError instanceof Error ? loadError : new Error(String(loadError)));
    }
  }, [claim, client, identity.organizationId, owns]);

  useEffect(() => {
    void load();
  }, [load]);

  if (error && !settings) {
    return (
      <RowLoadFailure
        title="Couldn't load the Only me chats setting."
        error={error}
        onRetry={() => void load()}
      />
    );
  }
  if (!settings) return <SettingRowSkeleton />;

  const unavailable = !settings.available && !settings.enabled;
  return (
    <SettingRowGroup>
      <SettingRow
        label="Only me chats"
        description="Lets people start chats only they can see in shared workspaces. Personal workspaces are always private."
        control={
          <Switch
            aria-label="Only me chats"
            checked={pending ?? settings.enabled}
            pending={pending !== null}
            disabled={unavailable}
            disabledReason={
              unavailable
                ? "Private chats aren't turned on for this installation. Ask whoever runs your Opengeni to enable them."
                : undefined
            }
            onCheckedChange={async (enabled) => {
              const operation = claim("mutation");
              setPending(enabled);
              try {
                const value = await updateOrganizationPrivateSessionSettings(
                  client,
                  identity.organizationId,
                  { enabled, expectedVersion: settings.version, operationId: crypto.randomUUID() },
                );
                if (!owns(operation)) return;
                setSettings(value);
                toast.success(
                  enabled
                    ? "People can start Only me chats"
                    : "Only me chats are off for new chats",
                );
              } catch (saveError) {
                if (!owns(operation)) return;
                if (isOrganizationConflict(saveError)) await load();
                toast.error("Couldn't change Only me chats", {
                  description: userErrorText(saveError),
                });
              } finally {
                if (owns(operation)) setPending(null);
              }
            }}
          />
        }
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
