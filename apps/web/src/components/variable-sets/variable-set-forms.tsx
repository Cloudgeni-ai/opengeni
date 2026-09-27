import { useState } from "react";

import { Disclosure } from "@/components/ui/disclosure";
import { Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { FormDialog } from "@/components/ui/form-dialog";
import { InlineHelp } from "@/components/ui/inline-help";
import {
  EnvPastePreview,
  SecretInput,
  importableEnvRows,
  normalizeVariableName,
  parseEnvText,
  variableNameIssue,
  type EnvRow,
} from "@/components/ui/secret-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import type { WorkspaceVariableSet } from "@/types";

import { joinAnd, scopeHint, scopeLocked, type VariableSetScope } from "./variable-set-model";

/* ----------------------------------------------------------------------------
   New variable set, Add variables (one, or a pasted .env) and Edit details are
   their own pages with a back link and a sticky footer. Replace value is the
   one small centered dialog. Server errors show inside the form.
   -------------------------------------------------------------------------- */

const NAME_HINT = "Letters, numbers and underscores. Saved in uppercase.";
const TAKES_EFFECT =
  "Takes effect from the next turn. Turns already running keep the current value.";

export interface NewVariableInput {
  name: string;
  value: string;
}

function envProblems(rows: EnvRow[]): string | undefined {
  const empty = importableEnvRows(rows).filter((row) => row.value === "");
  if (empty.length === 0) return undefined;
  const names = empty.map((row) => row.name);
  return `Add a value for ${joinAnd(names)}, or remove ${names.length === 1 ? "that line" : "those lines"}.`;
}

function sameName(left: string, right: string): boolean {
  return left.trim().toLocaleLowerCase() === right.trim().toLocaleLowerCase();
}

/* ----------------------------------------------------------------------------
   New variable set.
   -------------------------------------------------------------------------- */

export interface NewSetValues {
  scope: VariableSetScope;
  name: string;
  description: string;
  variables: NewVariableInput[];
}

export function NewVariableSetPage({
  sets,
  organizationName,
  organizationEnabled,
  personalEnabled,
  onClose,
  onCreate,
}: {
  sets: WorkspaceVariableSet[];
  organizationName: string;
  /** Organization admins only. */
  organizationEnabled: boolean;
  /** Members of the organization with their own identity. */
  personalEnabled: boolean;
  onClose: () => void;
  /** Saves the set and opens it. Throws a user-facing error. */
  onCreate: (values: NewSetValues) => Promise<void>;
}) {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [scope, setScope] = useState<VariableSetScope>("workspace");
  const [env, setEnv] = useState("");
  const [tried, setTried] = useState(false);

  const trimmed = name.trim();
  const duplicate = Boolean(trimmed) && sets.some((set) => sameName(set.name, trimmed));
  const nameError = duplicate
    ? `There's already a variable set called ${trimmed}. Pick another name.`
    : tried && !trimmed
      ? "Name the variable set."
      : undefined;
  const rows = env.trim() ? parseEnvText(env) : [];
  const envError = tried ? envProblems(rows) : undefined;
  const importable = importableEnvRows(rows);

  return (
    <FlushFormPage
      backLabel="Variable sets"
      onClose={onClose}
      title="New variable set"
      submitLabel="Create variable set"
      pendingLabel="Creating…"
      onSubmit={async () => {
        setTried(true);
        if (!trimmed || duplicate || envProblems(rows)) return false;
        await onCreate({
          scope,
          name: trimmed,
          description: description.trim(),
          variables: importable.map((row) => ({ name: row.name, value: row.value })),
        });
        return true;
      }}
    >
      <FieldStack>
        <Field label="Name" error={nameError}>
          <TextInput
            name="variable-set-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="e.g. Staging AWS"
            suppressAutofill
            autoComplete="off"
            maxLength={120}
          />
        </Field>
        <Field label="Description" optional hint="One line on what it's for.">
          <TextInput
            name="variable-set-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            placeholder="e.g. Read-only staging credentials"
            autoComplete="off"
            maxLength={2000}
          />
        </Field>
        <Field
          label="Available to"
          group
          hint={
            <>
              {scopeHint(scope, organizationName)}{" "}
              <span className="text-fg">You can't change this later.</span>
            </>
          }
        >
          <SegmentedControl
            fullWidth
            className="max-w-[440px]"
            value={scope}
            onValueChange={setScope}
            options={[
              { value: "workspace", label: "Workspace" },
              {
                value: "organization",
                label: "Organization",
                disabled: !organizationEnabled,
                disabledReason: "Only organization admins can create organization sets.",
              },
              {
                value: "user",
                label: "Only me",
                disabled: !personalEnabled,
                disabledReason: "Personal sets need a signed-in organization member.",
              },
            ]}
          />
        </Field>
        <Disclosure
          title="Add variables now"
          summary={
            importable.length
              ? `${plural(importable.length)} from a pasted .env`
              : "Optional. Paste a .env file."
          }
        >
          <FieldStack className="gap-4">
            <Field
              label="Variables"
              optional
              error={envError}
              hint={
                rows.length
                  ? undefined
                  : "Paste a .env file: one NAME=value per line. You can add more later."
              }
            >
              <TextArea
                mono
                rows={4}
                value={env}
                onChange={(event) => setEnv(event.target.value)}
                placeholder={"AWS_ACCESS_KEY_ID=…\nAWS_REGION=eu-north-1"}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            {rows.length ? <EnvPastePreview rows={rows} /> : null}
          </FieldStack>
        </Disclosure>
      </FieldStack>
    </FlushFormPage>
  );
}

function plural(count: number): string {
  return `${count} ${count === 1 ? "variable" : "variables"}`;
}

/* ----------------------------------------------------------------------------
   Add variable (one, or a pasted .env).
   -------------------------------------------------------------------------- */

export type AddMode = "one" | "paste";

export function AddVariablePage({
  set,
  initialMode,
  onClose,
  onAdd,
}: {
  set: WorkspaceVariableSet;
  initialMode: AddMode;
  onClose: () => void;
  /** Saves the values. Throws a user-facing error. */
  onAdd: (variables: NewVariableInput[], replaced: string[]) => Promise<void>;
}) {
  const [mode, setMode] = useState<AddMode>(initialMode);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [env, setEnv] = useState("");
  const [tried, setTried] = useState(false);

  const existing = set.variables.map((variable) => variable.name);
  const normalized = normalizeVariableName(name);
  const issue = normalized
    ? variableNameIssue(normalized, existing)
    : name.trim()
      ? { message: "Start the name with a letter." }
      : null;
  const nameError = issue?.message ?? (tried && !normalized ? "Name the variable." : undefined);
  const valueError = tried && !value ? "Enter a value." : undefined;
  const rows = env.trim() ? parseEnvText(env, existing) : [];
  const importable = importableEnvRows(rows);
  const envError = tried ? envProblems(rows) : undefined;
  const paste = mode === "paste";
  const count = importable.length;

  return (
    <FlushFormPage
      backLabel={set.name}
      onClose={onClose}
      title={paste ? "Add variables" : "Add variable"}
      description={`In ${set.name}. Agents get ${paste ? "them" : "it"} from the next turn.`}
      submitLabel={paste ? (count > 0 ? `Add ${plural(count)}` : "Add variables") : "Add variable"}
      pendingLabel="Adding…"
      submitDisabled={paste && count === 0}
      onSubmit={async () => {
        setTried(true);
        if (paste) {
          if (count === 0 || envProblems(rows)) return false;
          await onAdd(
            importable.map((row) => ({ name: row.name, value: row.value })),
            importable.filter((row) => row.status === "replace").map((row) => row.name),
          );
          return true;
        }
        if (issue || !normalized || !value) return false;
        await onAdd([{ name: normalized, value }], []);
        return true;
      }}
    >
      <FieldStack>
        <SegmentedControl
          aria-label="How to add"
          size="sm"
          className="self-start"
          value={mode}
          onValueChange={setMode}
          options={[
            { value: "one", label: "One variable" },
            { value: "paste", label: "Paste .env" },
          ]}
        />
        {paste ? (
          <>
            <Field
              label="Variables"
              error={envError}
              hint={
                rows.length
                  ? undefined
                  : "One NAME=value per line. Comments and export are ignored."
              }
            >
              <TextArea
                mono
                rows={5}
                value={env}
                onChange={(event) => setEnv(event.target.value)}
                placeholder={"DATABASE_URL=postgres://…\nPGSSLMODE=require"}
                spellCheck={false}
                autoComplete="off"
              />
            </Field>
            {rows.length ? <EnvPastePreview rows={rows} /> : null}
          </>
        ) : (
          <>
            <Field
              label="Name"
              error={nameError}
              hint={
                normalized && normalized !== name ? (
                  <>
                    Saved as <span className="font-mono text-fg">{normalized}</span>
                  </>
                ) : (
                  NAME_HINT
                )
              }
            >
              <TextInput
                mono
                name="variable-name"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="e.g. DATABASE_URL"
                suppressAutofill
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
              />
            </Field>
            <Field
              label="Value"
              error={valueError}
              hint="Hidden after you save it. Agents still get it in their sandbox."
            >
              <SecretInput
                multiline
                rows={2}
                name="variable-value"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                placeholder="Paste the value"
              />
            </Field>
          </>
        )}
      </FieldStack>
    </FlushFormPage>
  );
}

/* ----------------------------------------------------------------------------
   Replace value: a one-field prompt.
   -------------------------------------------------------------------------- */

export function ReplaceValueDialog({
  set,
  variableName,
  onClose,
  onReplace,
}: {
  set: WorkspaceVariableSet | undefined;
  variableName: string | null;
  onClose: () => void;
  /** Saves the new value. Throws a user-facing error. */
  onReplace: (value: string) => Promise<void>;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const open = Boolean(set && variableName);
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setValue("");
          setError(undefined);
          onClose();
        }
      }}
      size="sm"
      title="Replace value"
      description={
        set && variableName
          ? `${variableName} in ${set.name}. The old value can't be restored.`
          : undefined
      }
      submitLabel="Replace value"
      pendingLabel="Replacing…"
      onSubmit={async () => {
        if (!value) {
          setError("Enter the new value.");
          return false;
        }
        await onReplace(value);
        setValue("");
        return true;
      }}
    >
      {variableName ? (
        <FieldStack>
          <Field label="Name">
            <TextInput mono readOnly value={variableName} />
          </Field>
          <Field label="New value" error={error} hint={TAKES_EFFECT}>
            <SecretInput
              multiline
              rows={2}
              name="variable-value"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(undefined);
              }}
              placeholder="Paste the new value"
            />
          </Field>
        </FieldStack>
      ) : null}
    </FormDialog>
  );
}

/* ----------------------------------------------------------------------------
   Edit details (name and description).
   -------------------------------------------------------------------------- */

export function EditVariableSetPage({
  set,
  sets,
  organizationName,
  onClose,
  onSave,
}: {
  set: WorkspaceVariableSet;
  sets: WorkspaceVariableSet[];
  organizationName: string;
  onClose: () => void;
  /** Saves the details. Throws a user-facing error. */
  onSave: (name: string, description: string | null) => Promise<void>;
}) {
  const [name, setName] = useState(set.name);
  const [description, setDescription] = useState(set.description ?? "");
  const [tried, setTried] = useState(false);

  const trimmed = name.trim();
  const duplicate = sets.some((other) => other.id !== set.id && sameName(other.name, trimmed));
  const nameError = duplicate
    ? `There's already a variable set called ${trimmed}. Pick another name.`
    : tried && !trimmed
      ? "Name the variable set."
      : undefined;
  const changed = trimmed !== set.name || description.trim() !== (set.description ?? "");

  return (
    <FlushFormPage
      backLabel={set.name}
      onClose={onClose}
      title="Edit details"
      description={`The name and description of ${set.name}.`}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      submitDisabled={!changed}
      onSubmit={async () => {
        setTried(true);
        if (!trimmed || duplicate) return false;
        await onSave(trimmed, description.trim() ? description.trim() : null);
        return true;
      }}
    >
      <FieldStack>
        <Field label="Name" error={nameError}>
          <TextInput
            name="variable-set-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            suppressAutofill
            autoComplete="off"
            maxLength={120}
          />
        </Field>
        <Field label="Description" optional hint="One line on what it's for.">
          <TextInput
            name="variable-set-description"
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            autoComplete="off"
            maxLength={2000}
          />
        </Field>
        <InlineHelp icon>{scopeLocked(set.scope, organizationName)}</InlineHelp>
      </FieldStack>
    </FlushFormPage>
  );
}
