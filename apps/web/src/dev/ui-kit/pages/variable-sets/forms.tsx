import { useEffect, useState, type ReactNode } from "react";

import { Disclosure } from "@/components/ui/disclosure";
import { CheckboxField, Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FormDialog, FormFrame, FormPage, type FormFrameProps } from "@/components/ui/form-dialog";
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

import { variableNameRules, type VariableSetScope } from "../../fixtures";
import { usePick } from "../../picks";
import { useAnswers, usePagePicks, useVerbs } from "./answers";
import {
  SCOPE_HINT,
  SCOPE_LABEL,
  SCOPE_LOCKED,
  joinAnd,
  type NewVariable,
  type PreviewSet,
  type PreviewVariable,
} from "./model";

/* ----------------------------------------------------------------------------
   Create and edit forms for the Variable sets pages. New variable set, Add
   variables and Edit details are their own pages with a back link and a
   sticky footer (the decided form pick). Only the one-field Replace value
   stays a small centered dialog.
   -------------------------------------------------------------------------- */

export const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** "page" is the in-preview page; "panel" draws the same form framed in place, for the kit's state grids. */
export type FormPresentation = "page" | "panel";

type FrameProps = Omit<FormFrameProps, "variant" | "children" | "onCancel" | "onSubmitted">;

/** Renders one create or edit form as its own page (the decided form pick). */
export function FormHost({
  presentation,
  open,
  onClose,
  onSubmitted,
  back,
  frame,
  children,
}: {
  presentation: FormPresentation;
  open: boolean;
  onClose: () => void;
  onSubmitted: () => void;
  /** The back link ("Variable sets", or the set's name). */
  back?: { label: ReactNode; onClick: () => void };
  frame: FrameProps;
  children: ReactNode;
}) {
  if (!open) return null;
  if (presentation === "panel") {
    return (
      <FormFrame
        variant="dialog"
        {...frame}
        showClose={false}
        onCancel={onClose}
        onSubmitted={onSubmitted}
        className="w-full max-w-[640px]"
      >
        {children}
      </FormFrame>
    );
  }
  return (
    <FormPage
      {...frame}
      back={back}
      onCancel={onClose}
      onSubmitted={onSubmitted}
      className="min-h-full"
    >
      {children}
    </FormPage>
  );
}

/* ----------------------------------------------------------------------------
   New variable set.
   -------------------------------------------------------------------------- */

export interface SetTemplate {
  id: string;
  name: string;
  description: string;
  env: string;
}

export const SET_TEMPLATES: SetTemplate[] = [
  {
    id: "aws",
    name: "AWS staging",
    description: "Read-only IAM credentials for the staging AWS account.",
    env: "AWS_ACCESS_KEY_ID=\nAWS_SECRET_ACCESS_KEY=\nAWS_REGION=eu-north-1",
  },
  {
    id: "github",
    name: "GitHub bot",
    description: "Bot token for opening pull requests in the acme-robotics org.",
    env: "GITHUB_BOT_TOKEN=\nGITHUB_ORG=acme-robotics",
  },
  {
    id: "database",
    name: "Staging database",
    description: "Read-only connection to the staging Postgres.",
    env: "DATABASE_URL=\nPGSSLMODE=require",
  },
];

export interface NewSetValues {
  name: string;
  description: string;
  scope: VariableSetScope;
  env: string;
}

function emptyNewSet(template?: SetTemplate): NewSetValues {
  return {
    name: template?.name ?? "",
    description: template?.description ?? "",
    scope: "workspace",
    env: template?.env ?? "",
  };
}

function envProblems(rows: EnvRow[]): string | undefined {
  const empty = importableEnvRows(rows).filter((row) => row.value === "");
  if (empty.length === 0) return undefined;
  const names = empty.map((row) => row.name);
  return `Add a value for ${joinAnd(names)}, or remove ${names.length === 1 ? "that line" : "those lines"}.`;
}

export function NewSetForm({
  presentation,
  open,
  template,
  sets,
  onClose,
  onCreate,
  back,
}: {
  presentation: FormPresentation;
  open: boolean;
  template?: SetTemplate;
  sets: PreviewSet[];
  onClose: () => void;
  /** Saves the set; the page then opens it. */
  onCreate: (values: NewSetValues, variables: NewVariable[]) => void;
  back?: { label: ReactNode; onClick: () => void };
}) {
  const picks = usePagePicks();
  const disclosure = usePick("disclosure");
  const [values, setValues] = useState(() => emptyNewSet(template));
  const [tried, setTried] = useState(false);

  // Every open starts clean (or from the template that opened it).
  useEffect(() => {
    if (open) {
      setValues(emptyNewSet(template));
      setTried(false);
    }
  }, [open, template]);

  const update = <Key extends keyof NewSetValues>(key: Key, value: NewSetValues[Key]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const name = values.name.trim();
  const duplicate = sets.some(
    (set) => set.name.toLocaleLowerCase() === name.toLocaleLowerCase() && name,
  );
  const nameError = duplicate
    ? `There's already a variable set called ${name}. Pick another name.`
    : tried && !name
      ? "Name the variable set."
      : undefined;
  const rows = values.env.trim() ? parseEnvText(values.env) : [];
  const envError = tried ? envProblems(rows) : undefined;
  const importable = importableEnvRows(rows);

  const envField = (
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
          value={values.env}
          onChange={(event) => update("env", event.target.value)}
          placeholder={"AWS_ACCESS_KEY_ID=…\nAWS_REGION=eu-north-1"}
          spellCheck={false}
        />
      </Field>
      {rows.length ? <EnvPastePreview rows={rows} /> : null}
    </FieldStack>
  );

  return (
    <FormHost
      presentation={presentation}
      open={open}
      onClose={onClose}
      // onCreate navigates to the new set, so a successful submit does not close back to the list.
      onSubmitted={() => undefined}
      back={back}
      frame={{
        title: "New variable set",
        submitLabel: "Create variable set",
        pendingLabel: "Creating…",
        onSubmit: async () => {
          setTried(true);
          if (!name || duplicate || envProblems(rows)) return false;
          await wait(650);
          onCreate(
            { ...values, name, description: values.description.trim() },
            importable.map((row) => ({ name: row.name, kind: "secret", value: row.value })),
          );
          return true;
        },
      }}
    >
      <FieldStack>
        <Field label="Name" error={nameError}>
          <TextInput
            value={values.name}
            onChange={(event) => update("name", event.target.value)}
            placeholder="e.g. Staging AWS"
            suppressAutofill
            maxLength={80}
          />
        </Field>
        <Field label="Description" optional hint="One line on what it's for.">
          <TextInput
            value={values.description}
            onChange={(event) => update("description", event.target.value)}
            placeholder="e.g. Read-only staging credentials"
            suppressAutofill
            maxLength={160}
          />
        </Field>
        <Field
          label="Available to"
          group
          hint={
            <>
              {SCOPE_HINT[values.scope]}{" "}
              <span className="text-fg">You can't change this later.</span>
            </>
          }
        >
          <SegmentedControl
            variant={picks.segmented}
            fullWidth
            className="max-w-[440px]"
            value={values.scope}
            onValueChange={(scope) => update("scope", scope)}
            // Short labels so three fit a phone; the hint says who that means.
            options={[
              { value: "workspace", label: "Workspace" },
              { value: "organization", label: SCOPE_LABEL.organization },
              { value: "personal", label: SCOPE_LABEL.personal },
            ]}
          />
        </Field>
        {disclosure === "c" ? (
          envField
        ) : (
          <Disclosure
            variant={disclosure === "b" ? "inline" : "row"}
            title="Add variables now"
            summary={
              importable.length
                ? `${importable.length} from a pasted .env`
                : "Optional. Paste a .env file."
            }
            defaultOpen={Boolean(template)}
          >
            {envField}
          </Disclosure>
        )}
      </FieldStack>
    </FormHost>
  );
}

/* ----------------------------------------------------------------------------
   Add variable (one, or a pasted .env).
   -------------------------------------------------------------------------- */

export type AddMode = "one" | "paste";

interface AddValues {
  mode: AddMode;
  name: string;
  value: string;
  env: string;
  secret: boolean;
}

export function AddVariableForm({
  presentation,
  open,
  set,
  initialMode = "one",
  initialValues,
  onClose,
  onAdd,
  back,
}: {
  presentation: FormPresentation;
  open: boolean;
  set: PreviewSet | undefined;
  initialMode?: AddMode;
  /** Prefilled fields, for the kit's dialog previews. */
  initialValues?: { name?: string; env?: string };
  onClose: () => void;
  onAdd: (variables: NewVariable[], replaced: string[]) => void;
  back?: { label: ReactNode; onClick: () => void };
}) {
  const picks = usePagePicks();
  const answers = useAnswers();
  const plainOn = answers.plain === "shown";
  const initialName = initialValues?.name ?? "";
  const initialEnv = initialValues?.env ?? "";
  const [values, setValues] = useState<AddValues>({
    mode: initialMode,
    name: initialName,
    value: "",
    env: initialEnv,
    secret: true,
  });
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (open) {
      setValues({ mode: initialMode, name: initialName, value: "", env: initialEnv, secret: true });
      setTried(false);
    }
  }, [open, initialMode, initialName, initialEnv]);

  if (!set) return null;
  const existing = set.variables.map((variable) => variable.name);
  const update = <Key extends keyof AddValues>(key: Key, value: AddValues[Key]) =>
    setValues((current) => ({ ...current, [key]: value }));

  const normalized = normalizeVariableName(values.name);
  const issue = normalized ? variableNameIssue(normalized, existing) : null;
  const nameError = issue?.message ?? (tried && !normalized ? "Name the variable." : undefined);
  const valueError = tried && !values.value ? "Enter a value." : undefined;
  const rows = values.env.trim() ? parseEnvText(values.env, existing) : [];
  const importable = importableEnvRows(rows);
  const envError = tried ? envProblems(rows) : undefined;
  const plainValue = plainOn && !values.secret;

  const paste = values.mode === "paste";
  const count = importable.length;

  return (
    <FormHost
      presentation={presentation}
      open={open}
      onClose={onClose}
      onSubmitted={onClose}
      back={back}
      frame={{
        title: paste ? "Add variables" : "Add variable",
        description: `In ${set.name}. Agents get ${paste ? "them" : "it"} from the next turn.`,
        submitLabel: paste
          ? count > 0
            ? `Add ${count} ${count === 1 ? "variable" : "variables"}`
            : "Add variables"
          : "Add variable",
        pendingLabel: "Adding…",
        submitDisabled: paste && count === 0,
        onSubmit: async () => {
          setTried(true);
          if (paste) {
            if (count === 0 || envProblems(rows)) return false;
            await wait(650);
            onAdd(
              importable.map((row) => ({ name: row.name, kind: "secret", value: row.value })),
              importable.filter((row) => row.status === "replace").map((row) => row.name),
            );
            return true;
          }
          if (issue || !normalized || !values.value) return false;
          await wait(650);
          onAdd(
            [
              {
                name: normalized,
                kind: plainValue ? "plain" : "secret",
                value: plainValue ? values.value : undefined,
              },
            ],
            [],
          );
          return true;
        },
      }}
    >
      <FieldStack>
        <SegmentedControl
          aria-label="How to add"
          variant={picks.segmented}
          size="sm"
          className="self-start"
          value={values.mode}
          onValueChange={(mode) => update("mode", mode)}
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
                value={values.env}
                onChange={(event) => update("env", event.target.value)}
                placeholder={"DATABASE_URL=postgres://…\nPGSSLMODE=require"}
                spellCheck={false}
              />
            </Field>
            {rows.length ? <EnvPastePreview rows={rows} /> : null}
            {plainOn && rows.length ? (
              <InlineHelp icon>Pasted values are saved as secrets. Edit one to show it.</InlineHelp>
            ) : null}
          </>
        ) : (
          <>
            <Field
              label="Name"
              error={nameError}
              hint={
                normalized && normalized !== values.name ? (
                  <>
                    Saved as <span className="font-mono text-fg">{normalized}</span>
                  </>
                ) : (
                  variableNameRules.hint
                )
              }
            >
              <TextInput
                mono
                value={values.name}
                onChange={(event) => update("name", event.target.value)}
                placeholder="e.g. DATABASE_URL"
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                data-1p-ignore
                data-lpignore="true"
              />
            </Field>
            <Field
              label="Value"
              error={valueError}
              hint={
                plainValue
                  ? "Shown on this page. Anyone who can see this set can read it."
                  : "Hidden after you save it. Agents still get it in their sandbox."
              }
            >
              {plainValue ? (
                <TextArea
                  mono
                  rows={2}
                  value={values.value}
                  onChange={(event) => update("value", event.target.value)}
                  spellCheck={false}
                />
              ) : (
                <SecretInput
                  multiline
                  rows={2}
                  value={values.value}
                  onChange={(event) => update("value", event.target.value)}
                  placeholder="Paste the value"
                />
              )}
            </Field>
            {plainOn ? (
              <CheckboxField
                label="Secret"
                description="Hide the value after saving. Turn it off for config like a region or an account ID."
                checked={values.secret}
                onCheckedChange={(secret) => update("secret", secret)}
              />
            ) : null}
          </>
        )}
      </FieldStack>
    </FormHost>
  );
}

/* ----------------------------------------------------------------------------
   Replace value (Q16: or "Rotate"), always a dialog.
   -------------------------------------------------------------------------- */

export function ReplaceValueDialog({
  set,
  variable,
  onClose,
  onReplace,
  presentation = "dialog",
}: {
  set: PreviewSet | undefined;
  variable: PreviewVariable | undefined;
  onClose: () => void;
  onReplace: (value: string) => void;
  /** "panel" draws it in place, for the kit's dialog previews. */
  presentation?: "dialog" | "panel";
}) {
  const verbs = useVerbs();
  const answers = useAnswers();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  const open = Boolean(set && variable);
  const editPlain = answers.plain === "shown" && variable?.kind === "plain";

  useEffect(() => {
    if (open) {
      setValue(editPlain ? (variable?.value ?? "") : "");
      setError(undefined);
    }
  }, [open, editPlain, variable]);

  const frame = {
    title: editPlain ? "Edit value" : verbs.replace,
    description:
      set && variable
        ? editPlain
          ? `${variable.name} in ${set.name}.`
          : `${variable.name} in ${set.name}. The old value can't be restored.`
        : undefined,
    submitLabel: editPlain ? "Save" : verbs.replace,
    pendingLabel: editPlain ? "Saving…" : verbs.replacing,
    onSubmit: async () => {
      if (!value) {
        setError("Enter the new value.");
        return false;
      }
      await wait(650);
      onReplace(value);
      return true;
    },
  };

  const fields = variable ? (
    <FieldStack>
      <Field label="Name">
        <TextInput mono readOnly value={variable.name} />
      </Field>
      <Field
        label={editPlain ? "Value" : "New value"}
        error={error}
        hint={variableNameRules.replaceHint}
      >
        {editPlain ? (
          <TextArea
            mono
            rows={2}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
            spellCheck={false}
          />
        ) : (
          <SecretInput
            multiline
            rows={2}
            value={value}
            onChange={(event) => {
              setValue(event.target.value);
              setError(undefined);
            }}
            placeholder="Paste the new value"
          />
        )}
      </Field>
    </FieldStack>
  ) : null;

  if (presentation === "panel") {
    return (
      <FormFrame
        variant="dialog"
        {...frame}
        onCancel={onClose}
        onSubmitted={onClose}
        className="w-full max-w-[560px]"
      >
        {fields}
      </FormFrame>
    );
  }
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => (next ? undefined : onClose())}
      {...frame}
      onSubmitted={onClose}
    >
      {fields}
    </FormDialog>
  );
}

/* ----------------------------------------------------------------------------
   Edit details (name and description): its own page, back to the set.
   -------------------------------------------------------------------------- */

export function EditSetForm({
  presentation = "page",
  set,
  sets,
  onClose,
  onSave,
}: {
  presentation?: FormPresentation;
  set: PreviewSet | undefined;
  sets: PreviewSet[];
  onClose: () => void;
  onSave: (name: string, description: string) => void;
}) {
  const [name, setName] = useState(set?.name ?? "");
  const [description, setDescription] = useState(set?.description ?? "");
  const [tried, setTried] = useState(false);

  useEffect(() => {
    if (set) {
      setName(set.name);
      setDescription(set.description);
      setTried(false);
    }
  }, [set]);

  const trimmed = name.trim();
  const duplicate = sets.some(
    (other) =>
      other.id !== set?.id && other.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase(),
  );
  const nameError = duplicate
    ? `There's already a variable set called ${trimmed}. Pick another name.`
    : tried && !trimmed
      ? "Name the variable set."
      : undefined;

  return (
    <FormHost
      presentation={presentation}
      open={Boolean(set)}
      onClose={onClose}
      onSubmitted={onClose}
      back={set ? { label: set.name, onClick: onClose } : undefined}
      frame={{
        title: "Edit details",
        description: set ? `The name and description of ${set.name}.` : undefined,
        submitLabel: "Save changes",
        pendingLabel: "Saving…",
        onSubmit: async () => {
          setTried(true);
          if (!trimmed || duplicate) return false;
          await wait(500);
          onSave(trimmed, description.trim());
          return true;
        },
      }}
    >
      <FieldStack>
        <Field label="Name" error={nameError}>
          <TextInput
            value={name}
            onChange={(event) => setName(event.target.value)}
            suppressAutofill
            maxLength={80}
          />
        </Field>
        <Field label="Description" optional hint="One line on what it's for.">
          <TextInput
            value={description}
            onChange={(event) => setDescription(event.target.value)}
            suppressAutofill
            maxLength={160}
          />
        </Field>
        {set ? <InlineHelp icon>{SCOPE_LOCKED[set.scope]}</InlineHelp> : null}
      </FieldStack>
    </FormHost>
  );
}
