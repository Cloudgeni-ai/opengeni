import { isValidSecretName, VAULT_LIMITS } from "@opengeni/contracts";
import {
  vaultErrorCode,
  type CreateVaultRequest,
  type VaultAvailability,
  type VaultSummary,
} from "@opengeni/react";
import { useState, type ReactNode } from "react";

import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { FormDialog } from "@/components/ui/form-dialog";
import { SegmentedControl } from "@/components/ui/segmented-control";

import {
  AvailabilityEditor,
  DEFAULT_AVAILABILITY,
  type AvailabilityWorkspace,
} from "./availability-editor";
import { vaultErrorText } from "./vault-model";

/* ----------------------------------------------------------------------------
   New vault (S5) and the vault's own small forms: Rename (one-field dialog)
   and Available in (S6, a form page).
   -------------------------------------------------------------------------- */

type Owner = CreateVaultRequest["ownerKind"];

function nameIssue(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Give the vault a name.";
  if (!isValidSecretName(trimmed))
    return "Names can't contain /, {, }, # or \\, or start with id:.";
  return undefined;
}

function causeOf(error: unknown): unknown {
  return (error as { cause?: unknown } | null)?.cause ?? error;
}

export function NewVaultPage({
  canCreateWorkspace,
  canCreateOrganization,
  organizationName,
  workspaces,
  onClose,
  onCreate,
}: {
  canCreateWorkspace: boolean;
  canCreateOrganization: boolean;
  organizationName: string;
  workspaces: AvailabilityWorkspace[];
  onClose: () => void;
  onCreate: (request: CreateVaultRequest) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [owner, setOwner] = useState<Owner>(canCreateWorkspace ? "workspace" : "user");
  const [availability, setAvailability] = useState<VaultAvailability>(DEFAULT_AVAILABILITY);
  const [nameError, setNameError] = useState<string | undefined>();
  const [availabilityError, setAvailabilityError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);

  const owners = [
    { value: "user" as const, label: "Only me" },
    ...(canCreateWorkspace ? [{ value: "workspace" as const, label: "This workspace" }] : []),
    ...(canCreateOrganization ? [{ value: "organization" as const, label: "Organization" }] : []),
  ];
  const ownerHint =
    owner === "user"
      ? "Only you can see it, and only work you start can use it."
      : owner === "workspace"
        ? "Everyone in this workspace can use it. Members can add items."
        : `Shared with ${organizationName}. Organization admins manage it.`;

  return (
    <FlushFormPage
      backLabel="Secrets"
      onClose={onClose}
      title="New vault"
      submitLabel="Create vault"
      pendingLabel="Creating…"
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        setFormError(null);
        const issue = nameIssue(name);
        setNameError(issue);
        if (owner === "organization" && availability.allowedWorkspaceIds?.length === 0) {
          setAvailabilityError("Pick at least one workspace, or choose All workspaces.");
          return false;
        }
        setAvailabilityError(undefined);
        if (issue) return false;
        try {
          await onCreate({
            name: name.trim(),
            ownerKind: owner,
            ...(description.trim() ? { description: description.trim() } : {}),
            ...(owner === "organization" ? { availability } : {}),
          });
          return true;
        } catch (error) {
          if (vaultErrorCode(causeOf(error)) === "vault_name_conflict") {
            setNameError("A vault with this name already exists. Choose another name.");
            return false;
          }
          setFormError(vaultErrorText(causeOf(error)));
          return false;
        }
      }}
    >
      <FieldStack>
        <Field label="Name" error={nameError}>
          <TextInput
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (nameError) setNameError(undefined);
            }}
            maxLength={VAULT_LIMITS.nameMaxChars}
            placeholder="Production"
            suppressAutofill
          />
        </Field>
        {owners.length > 1 ? (
          <Field label="Who can use it" hint={ownerHint} group>
            <SegmentedControl
              options={owners}
              value={owner}
              onValueChange={(next) => setOwner(next)}
              fullWidth
            />
          </Field>
        ) : null}
        {owner === "organization" ? (
          <AvailabilityEditor
            value={availability}
            onChange={(next) => {
              setAvailability(next);
              setAvailabilityError(undefined);
            }}
            workspaces={workspaces}
            organizationName={organizationName}
            error={availabilityError}
          />
        ) : null}
        <Field label="Description" optional>
          <TextArea
            rows={2}
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            maxLength={VAULT_LIMITS.descriptionMaxChars}
          />
        </Field>
      </FieldStack>
    </FlushFormPage>
  );
}

export function AvailabilityPage({
  vault,
  organizationName,
  workspaces,
  onClose,
  onSave,
}: {
  vault: VaultSummary;
  organizationName: string;
  workspaces: AvailabilityWorkspace[];
  onClose: () => void;
  onSave: (availability: VaultAvailability) => Promise<void>;
}) {
  const initial = vault.availability ?? DEFAULT_AVAILABILITY;
  const [availability, setAvailability] = useState<VaultAvailability>(initial);
  const [error, setError] = useState<string | undefined>();
  const [formError, setFormError] = useState<ReactNode>(null);
  const changed = JSON.stringify(availability) !== JSON.stringify(initial);
  return (
    <FlushFormPage
      backLabel={vault.name}
      onClose={onClose}
      title="Available in"
      description={`Which workspaces in ${organizationName} can use ${vault.name}.`}
      submitLabel="Save"
      pendingLabel="Saving…"
      submitDisabled={!changed}
      error={formError}
      onSubmit={async (event) => {
        event.preventDefault();
        if (availability.allowedWorkspaceIds?.length === 0) {
          setError("Pick at least one workspace, or choose All workspaces.");
          return false;
        }
        try {
          await onSave(availability);
          return true;
        } catch (caught) {
          setFormError(vaultErrorText(causeOf(caught)));
          return false;
        }
      }}
    >
      <AvailabilityEditor
        value={availability}
        onChange={(next) => {
          setAvailability(next);
          setError(undefined);
        }}
        workspaces={workspaces}
        organizationName={organizationName}
        error={error}
      />
    </FlushFormPage>
  );
}

export function RenameVaultDialog({
  vault,
  open,
  onOpenChange,
  onRename,
}: {
  vault: VaultSummary | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onRename: (name: string) => Promise<void>;
}) {
  const [name, setName] = useState(vault?.name ?? "");
  const [error, setError] = useState<string | undefined>();
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setName(vault?.name ?? "");
          setError(undefined);
        }
        onOpenChange(next);
      }}
      size="sm"
      title="Rename vault"
      description="References that use the old name keep working."
      submitLabel="Rename"
      pendingLabel="Renaming…"
      onSubmit={async (event) => {
        event.preventDefault();
        const issue = nameIssue(name);
        setError(issue);
        if (issue) return false;
        try {
          await onRename(name.trim());
          return true;
        } catch (caught) {
          setError(vaultErrorText(causeOf(caught)));
          return false;
        }
      }}
    >
      <Field label="Name" error={error}>
        <TextInput
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={VAULT_LIMITS.nameMaxChars}
          suppressAutofill
        />
      </Field>
    </FormDialog>
  );
}
