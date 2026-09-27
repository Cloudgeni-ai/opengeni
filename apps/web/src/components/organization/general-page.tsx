import { useEffect, useState } from "react";
import { toast } from "sonner";

import { RowButton } from "@/components/models/models-ui";
import { CopyField } from "@/components/ui/copy-field";
import { ErrorMessage } from "@/components/ui/error-message";
import { Field, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { Section, SectionStack } from "@/components/ui/section";
import { SettingRow, SettingRowGroup, SettingRowSkeleton } from "@/components/ui/setting-row";

import { useOrganizationDirectory } from "./organization-directory";

/* ----------------------------------------------------------------------------
   Organization settings > General: the organization's name and its ID.
   -------------------------------------------------------------------------- */

export function OrganizationGeneralPage() {
  const directory = useOrganizationDirectory();
  const [renameOpen, setRenameOpen] = useState(false);
  const overview = directory.overview;
  const organization = overview.value?.organization ?? null;

  if (overview.error && !organization) {
    return (
      <ErrorMessage
        variant="inline"
        title="Couldn't load the organization."
        action={<RowButton onClick={() => void directory.reload()}>Try again</RowButton>}
      >
        {overview.error.message}
      </ErrorMessage>
    );
  }

  return (
    <SectionStack>
      <Section title="Organization">
        <SettingRowGroup>
          {!organization ? (
            <SettingRowSkeleton />
          ) : (
            <>
              <SettingRow
                label="Name"
                description={organization.name}
                control={<RowButton onClick={() => setRenameOpen(true)}>Rename</RowButton>}
              />
              <SettingRow
                label="Organization ID"
                description="For the API and support requests."
                controlWidth="auto"
                control={
                  <CopyField
                    value={organization.id}
                    label="organization ID"
                    size="md"
                    truncate="middle"
                    maxLength={20}
                  />
                }
              />
            </>
          )}
        </SettingRowGroup>
      </Section>
      {organization ? (
        <RenameOrganizationDialog
          open={renameOpen}
          onOpenChange={setRenameOpen}
          name={organization.name}
          onSave={directory.renameOrganization}
          singleUser={directory.singleUser}
        />
      ) : null}
    </SectionStack>
  );
}

function RenameOrganizationDialog({
  open,
  onOpenChange,
  name,
  onSave,
  singleUser,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  name: string;
  onSave: (name: string) => Promise<void>;
  singleUser: boolean;
}) {
  const [value, setValue] = useState(name);
  const [error, setError] = useState<string | null>(null);
  const trimmed = value.trim();
  useEffect(() => {
    if (!open) return;
    setValue(name);
    setError(null);
  }, [name, open]);
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Rename organization"
      description={
        singleUser ? undefined : "Everyone in the organization sees the new name right away."
      }
      submitLabel="Rename"
      pendingLabel="Renaming…"
      submitDisabled={trimmed === name}
      onSubmit={async () => {
        if (!trimmed) {
          setError("Name the organization.");
          return false;
        }
        await onSave(trimmed);
        toast.success(`Renamed the organization to ${trimmed}`);
        return true;
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <Field label="Name" error={error ?? undefined}>
        <TextInput
          value={value}
          maxLength={120}
          suppressAutofill
          onChange={(event) => {
            setValue(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}
