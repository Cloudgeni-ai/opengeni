import { useEffect, useState, type ReactNode } from "react";
import { EyeIcon } from "lucide-react";
import { toast } from "sonner";

import { DestructiveConfirm } from "@/components/ui/destructive-confirm";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { CheckboxField, Field, FieldStack, TextArea, TextInput } from "@/components/ui/field";
import { FormDialog, FormFrame, type FormFrameProps } from "@/components/ui/form-dialog";
import { ListRow, ListRowSkeleton, RowList, type RowListColumn } from "@/components/ui/list-row";
import {
  EnvPastePreview,
  SecretInput,
  SecretOnce,
  SecretValue,
  importableEnvRows,
  normalizeVariableName,
  parseEnvText,
  variableNameIssue,
} from "@/components/ui/secret-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { AddVariableRow } from "@/components/variable-sets/variable-set-forms";
import type { WorkspaceVariableSet } from "@/types";
import { Alternative, Fork, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import {
  newApiKeySecret,
  scheduleById,
  variableSetById,
  type Variable,
  type VariableSet,
} from "../fixtures";

/* ----------------------------------------------------------------------------
   Fixtures. Secret values exist only for the "Reveal with audit" version and
   are AWS's own documented example credentials.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const aws = variableSetById("vs-aws-production");
const github = variableSetById("vs-github-automation");
const financeExports = variableSetById("vs-finance-exports");
const awsSchedule = scheduleById("sched-aws-cost");

const EXAMPLE_SECRETS: Record<string, string> = {
  AWS_ACCESS_KEY_ID: "AKIAIOSFODNN7EXAMPLE",
  AWS_SECRET_ACCESS_KEY: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};

const PASTED_ENV = [
  "# From the renovate runner",
  "GITHUB_ORG=acme-robotics",
  "GITHUB_TOKEN=ghp_example_not_a_real_token",
  "RENOVATE_PLATFORM=github",
  'RENOVATE_AUTODISCOVER="false"',
].join("\n");

const PEM_VALUE = [
  "-----BEGIN OPENSSH PRIVATE KEY-----",
  "b3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAAAEbm9uZQAAAAAAAAABAAAAMwAAAAtzc2gtZW",
  "QyNTUxOQAAACBexampleexampleexampleexampleexampleexampleAAAAJgexample",
  "-----END OPENSSH PRIVATE KEY-----",
].join("\n");

export type SecretPolicy = "write-only" | "reveal" | "plain";

const COLUMNS: RowListColumn[] = [
  { id: "value", label: "Value", width: 300, hideLabel: true },
  { id: "updated", label: "Updated", width: 112, align: "end" },
];

/* ----------------------------------------------------------------------------
   Add variable and Replace value.
   -------------------------------------------------------------------------- */

interface AddValues {
  mode: "one" | "paste";
  name: string;
  value: string;
  env: string;
  secret: boolean;
}

const EMPTY_ADD: AddValues = { mode: "one", name: "", value: "", env: "", secret: true };

function ModeControl({
  value,
  onChange,
}: {
  value: AddValues["mode"];
  onChange: (value: AddValues["mode"]) => void;
}) {
  return (
    <SegmentedControl
      aria-label="How to add"
      options={[
        { value: "one", label: "One variable" },
        { value: "paste", label: "Paste .env" },
      ]}
      value={value}
      onValueChange={onChange}
      size="sm"
      className="self-start"
    />
  );
}

function addErrors(values: AddValues, existing: string[], submitted: boolean) {
  const name = normalizeVariableName(values.name);
  const issue = name ? variableNameIssue(name, existing) : null;
  return {
    name: issue?.message ?? (submitted && !name ? "Name the variable." : undefined),
    value: submitted && !values.value ? "Enter a value." : undefined,
  };
}

function AddVariableFields({
  values,
  onChange,
  set,
  policy,
  submitted = false,
  revealed = false,
}: {
  values: AddValues;
  onChange: (next: AddValues) => void;
  set: VariableSet;
  policy: SecretPolicy;
  submitted?: boolean;
  revealed?: boolean;
}) {
  const existing = set.variables.map((variable) => variable.name);
  const update = <K extends keyof AddValues>(key: K, value: AddValues[K]) =>
    onChange({ ...values, [key]: value });
  const normalized = normalizeVariableName(values.name);
  const errors = addErrors(values, existing, submitted);
  const rows = values.env.trim() ? parseEnvText(values.env, existing) : [];

  return (
    <FieldStack>
      <ModeControl value={values.mode} onChange={(mode) => update("mode", mode)} />
      {values.mode === "one" ? (
        <>
          <Field
            label="Name"
            error={errors.name}
            hint={
              normalized && normalized !== values.name ? (
                <>
                  Saved as <span className="font-mono text-fg">{normalized}</span>
                </>
              ) : (
                "Letters, numbers and underscores. Saved in uppercase."
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
            />
          </Field>
          <Field
            label="Value"
            error={errors.value}
            hint={
              policy === "plain" && !values.secret
                ? "Shown in the list. Anyone who can see this set can read it."
                : "Hidden after you save it. Agents still get the value in their sandbox."
            }
          >
            {policy === "plain" && !values.secret ? (
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
                defaultRevealed={revealed}
                value={values.value}
                onChange={(event) => update("value", event.target.value)}
              />
            )}
          </Field>
          {policy === "plain" ? (
            <CheckboxField
              label="Secret"
              description="Hide the value after saving. Turn it off for config like a region or an account ID."
              checked={values.secret}
              onCheckedChange={(secret) => update("secret", secret)}
            />
          ) : null}
        </>
      ) : (
        <>
          <Field
            label="Variables"
            hint={
              rows.length ? undefined : "One NAME=value per line. Comments and export are ignored."
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
        </>
      )}
    </FieldStack>
  );
}

function addFrameProps(
  values: AddValues,
  set: VariableSet,
): Pick<FormFrameProps, "title" | "description" | "submitLabel" | "pendingLabel"> {
  const count =
    values.mode === "paste"
      ? importableEnvRows(
          parseEnvText(
            values.env,
            set.variables.map((v) => v.name),
          ),
        ).length
      : 1;
  return {
    title: "Add variable",
    description: `To ${set.name}. New turns get it; turns already running don't.`,
    submitLabel:
      values.mode === "paste"
        ? count > 0
          ? `Add ${count} ${count === 1 ? "variable" : "variables"}`
          : "Add variables"
        : "Add variable",
    pendingLabel: "Adding…",
  };
}

/** A live panel of Add variable, for previews and states. */
function AddVariablePanel({
  set = aws,
  policy = "write-only",
  initial = EMPTY_ADD,
  submitted,
  revealed,
  className,
}: {
  set?: VariableSet;
  policy?: SecretPolicy;
  initial?: AddValues;
  submitted?: boolean;
  revealed?: boolean;
  className?: string;
}) {
  const [values, setValues] = useState(initial);
  const [tried, setTried] = useState(submitted ?? false);
  return (
    <FormFrame
      {...addFrameProps(values, set)}
      onSubmit={async () => {
        setTried(true);
        const errors = addErrors(
          values,
          set.variables.map((v) => v.name),
          true,
        );
        if (values.mode === "one" && (errors.name || errors.value)) return false;
        await wait(700);
        return true;
      }}
      onSubmitted={() => toast.success(`Added to ${set.name}`)}
      onCancel={() => {
        setValues(initial);
        setTried(false);
      }}
      submitDisabled={
        values.mode === "paste" &&
        !importableEnvRows(
          parseEnvText(
            values.env,
            set.variables.map((v) => v.name),
          ),
        ).length
      }
      className={className}
    >
      <AddVariableFields
        values={values}
        onChange={setValues}
        set={set}
        policy={policy}
        submitted={tried}
        revealed={revealed}
      />
    </FormFrame>
  );
}

function ReplaceValueFields({
  variable,
  defaultValue,
  revealed,
  value,
  onValueChange,
  error,
}: {
  variable: Variable;
  defaultValue?: string;
  revealed?: boolean;
  value?: string;
  onValueChange?: (value: string) => void;
  error?: string;
}) {
  return (
    <FieldStack>
      <Field label="Name">
        <TextInput mono readOnly value={variable.name} />
      </Field>
      <Field
        label="New value"
        error={error}
        hint="Takes effect from the next turn. Turns already running keep the current value."
      >
        <SecretInput
          multiline
          rows={2}
          defaultValue={value === undefined ? defaultValue : undefined}
          value={value}
          onChange={onValueChange ? (event) => onValueChange(event.target.value) : undefined}
          defaultRevealed={revealed}
          placeholder="Paste the new value"
        />
      </Field>
    </FieldStack>
  );
}

/** The live Replace value dialog: the new value is required. */
function ReplaceValueDialog({
  variable,
  set,
  onClose,
}: {
  variable: Variable;
  set: VariableSet;
  onClose: () => void;
}) {
  const [value, setValue] = useState("");
  const [error, setError] = useState<string>();
  return (
    <FormDialog
      open
      onOpenChange={(next) => (next ? undefined : onClose())}
      {...REPLACE_FRAME(variable, set)}
      onSubmit={async () => {
        if (!value) {
          setError("Enter the new value.");
          return false;
        }
        await wait(700);
        return true;
      }}
      onSubmitted={() => {
        toast.success(`Replaced ${variable.name}`);
        onClose();
      }}
    >
      <ReplaceValueFields
        variable={variable}
        value={value}
        onValueChange={(next) => {
          setValue(next);
          setError(undefined);
        }}
        error={error}
      />
    </FormDialog>
  );
}

const REPLACE_FRAME = (variable: Variable, set: VariableSet) => ({
  title: "Replace value",
  description: `${variable.name} in ${set.name}. The old value can't be restored.`,
  submitLabel: "Replace value",
  pendingLabel: "Replacing…",
});

/* ----------------------------------------------------------------------------
   The variables table, in the three policies.
   -------------------------------------------------------------------------- */

function useCountdown(active: boolean, seconds: number, onDone: () => void) {
  const [left, setLeft] = useState(seconds);
  useEffect(() => {
    if (!active) {
      setLeft(seconds);
      return;
    }
    const timer = setInterval(() => {
      setLeft((current) => {
        if (current <= 1) {
          clearInterval(timer);
          onDone();
          return seconds;
        }
        return current - 1;
      });
    }, 1000);
    return () => clearInterval(timer);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- restart only when a reveal starts
  }, [active]);
  return left;
}

function RevealedCell({ variable, onHide }: { variable: Variable; onHide: () => void }) {
  const left = useCountdown(true, 30, onHide);
  return (
    <SecretValue
      kind="secret"
      name={variable.name}
      revealed={EXAMPLE_SECRETS[variable.name] ?? "example-value"}
      revealNote={`Reveal logged · hides in ${left}s`}
      onHide={onHide}
    />
  );
}

function VariablesTable({
  policy,
  set = aws,
  initiallyRevealed,
  readOnlyReason,
}: {
  policy: SecretPolicy;
  set?: VariableSet;
  initiallyRevealed?: string;
  readOnlyReason?: string;
}) {
  const [revealed, setRevealed] = useState<string | null>(initiallyRevealed ?? null);
  const [replacing, setReplacing] = useState<Variable | null>(null);
  const [deleting, setDeleting] = useState<Variable | null>(null);

  return (
    <div className="min-w-0">
      <div className="mb-2 flex min-w-0 items-center justify-between gap-4">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-fg">Variables</h3>
          <p className="mt-0.5 truncate text-xs leading-4.5 text-fg-muted">{set.name}</p>
        </div>
      </div>
      <RowList variant="table" label={`Variables in ${set.name}`} columns={COLUMNS}>
        {set.variables.map((variable) => {
          const plain = policy === "plain" && variable.kind === "plain";
          const isRevealed = policy === "reveal" && revealed === variable.name;
          const value = isRevealed ? (
            <RevealedCell variable={variable} onHide={() => setRevealed(null)} />
          ) : (
            <SecretValue
              kind={plain ? "plain" : "secret"}
              value={plain ? variable.value : undefined}
              name={variable.name}
            />
          );
          return (
            <ListRow
              key={variable.name}
              title={<span className="font-mono text-xs">{variable.name}</span>}
              cells={{
                value,
                updated: <span className="text-xs text-fg-muted">{variable.updatedLabel}</span>,
              }}
              menuLabel={`Actions for ${variable.name}`}
              menu={
                readOnlyReason ? (
                  <DropdownMenuItem disabled>{readOnlyReason}</DropdownMenuItem>
                ) : (
                  <>
                    {policy === "reveal" && !isRevealed ? (
                      <DropdownMenuItem onSelect={() => setRevealed(variable.name)}>
                        <EyeIcon aria-hidden="true" />
                        Reveal value
                      </DropdownMenuItem>
                    ) : null}
                    <DropdownMenuItem onSelect={() => setReplacing(variable)}>
                      {plain ? "Edit value" : "Replace value"}
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                    <DropdownMenuItem variant="destructive" onSelect={() => setDeleting(variable)}>
                      Delete
                    </DropdownMenuItem>
                  </>
                )
              }
            />
          );
        })}
      </RowList>
      {readOnlyReason ? (
        <p className="mt-3 text-xs leading-4.5 text-fg-muted">{readOnlyReason}</p>
      ) : (
        // As in the product: one variable is added inline under the list.
        <AddVariableRow
          set={set as unknown as WorkspaceVariableSet}
          onAdd={async ({ name }) => {
            await wait(600);
            toast.success(`Added ${name} to ${set.name}`);
          }}
          onPaste={() => toast("Paste .env opens its own page")}
        />
      )}
      {replacing ? (
        <ReplaceValueDialog variable={replacing} set={set} onClose={() => setReplacing(null)} />
      ) : null}
      <DestructiveConfirm
        open={deleting !== null}
        onOpenChange={(next) => (next ? undefined : setDeleting(null))}
        title={`Delete ${deleting?.name ?? "variable"}?`}
        consequences={[
          `New turns in ${awsSchedule.name} won't get ${deleting?.name ?? "it"}.`,
          "Turns already running keep it.",
          "This can't be undone.",
        ]}
        confirmLabel="Delete variable"
        onConfirm={() => wait(700)}
      />
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return <p className="mt-4 text-xs leading-4.5 text-fg-muted">{children}</p>;
}

/* ----------------------------------------------------------------------------
   The section.
   -------------------------------------------------------------------------- */

export default function SecretValuesSection() {
  return (
    <KitSection sectionKey="secret-values">
      <Fork layout="stack">
        <Alternative id="a">
          <VariablesTable policy="write-only" />
          <Caption>
            Every value reads “Secret”, including AWS_REGION: without a flag there is no way to tell
            config from credentials. The row menu has Replace value and Delete only.
          </Caption>
        </Alternative>
        <Alternative id="b">
          <VariablesTable policy="reveal" initiallyRevealed="AWS_SECRET_ACCESS_KEY" />
          <Caption>
            Reveal value moves into the row menu. The value shows for 30 seconds and every reveal is
            written to the audit log. Screen shares and copy-paste can still leak it.
          </Caption>
        </Alternative>
        <Alternative id="c">
          <VariablesTable policy="plain" />
          <div className="mt-6 flex min-w-0 justify-center">
            <AddVariablePanel
              policy="plain"
              initial={{ ...EMPTY_ADD, name: "aws_default_output", value: "json", secret: false }}
              className="w-full max-w-[560px]"
            />
          </div>
          <Caption>
            Plain config shows inline with Copy; secrets stay write-only. Adding asks one question:
            Secret, on by default. Needs a Secret flag on variables in the backend.
          </Caption>
        </Alternative>
      </Fork>

      <StatesGrid
        columns={2}
        description="Write-only, the recommended version: adding, replacing, the saved row and the one-time view."
      >
        <StateCell label="Add variable · empty" align="stretch">
          <AddVariablePanel />
        </StateCell>
        <StateCell
          label="Typing · hidden"
          align="stretch"
          note="The name is shown as it will be saved."
        >
          <AddVariablePanel
            initial={{ ...EMPTY_ADD, name: "pg host-name", value: "db.staging.acme.internal" }}
          />
        </StateCell>
        <StateCell
          label="Typing · shown"
          align="stretch"
          note="The eye shows the value while typing. Nothing shows it after saving."
        >
          <AddVariablePanel
            revealed
            initial={{ ...EMPTY_ADD, name: "SENTRY_AUTH_TOKEN", value: "sntrys_example_7c1f0a" }}
          />
        </StateCell>
        <StateCell label="Reserved name" align="stretch">
          <AddVariablePanel
            set={github}
            initial={{ ...EMPTY_ADD, name: "GITHUB_TOKEN", value: "ghp_example" }}
          />
        </StateCell>
        <StateCell label="Already in this set" align="stretch">
          <AddVariablePanel initial={{ ...EMPTY_ADD, name: "aws_region", value: "eu-west-1" }} />
        </StateCell>
        <StateCell
          label="Paste .env"
          align="stretch"
          note="One reserved name and one duplicate, flagged before anything is saved."
        >
          <AddVariablePanel
            set={github}
            initial={{ ...EMPTY_ADD, mode: "paste", env: PASTED_ENV }}
          />
        </StateCell>
        <StateCell
          label="Replace value"
          align="stretch"
          note="Starts empty: the current value is never shown, not even as dots."
        >
          <FormFrame {...REPLACE_FRAME(aws.variables[1]!, aws)} className="w-full">
            <ReplaceValueFields variable={aws.variables[1]!} />
          </FormFrame>
        </StateCell>
        <StateCell
          label="Replace value · pasted and shown"
          align="stretch"
          note="Multi-line values (keys, certificates, JSON) keep their line breaks."
        >
          <FormFrame {...REPLACE_FRAME(aws.variables[1]!, aws)} className="w-full">
            <ReplaceValueFields variable={aws.variables[1]!} defaultValue={PEM_VALUE} revealed />
          </FormFrame>
        </StateCell>
        <StateCell label="Saved" span="full" align="stretch" padding={false}>
          <div className="px-5 py-4">
            <VariablesTable policy="write-only" />
          </div>
        </StateCell>
        <StateCell label="Loading" align="stretch">
          <RowList variant="table" label="Variables" columns={COLUMNS} busy>
            <ListRowSkeleton count={3} />
          </RowList>
        </StateCell>
        <StateCell
          label="Disabled with reason"
          align="stretch"
          note="An Organization set seen by a workspace admin: the menu says who can change it."
        >
          <VariablesTable
            policy="write-only"
            set={financeExports}
            readOnlyReason="Only organization owners can change Finance exports."
          />
        </StateCell>
        <StateCell
          label="Shown once"
          align="stretch"
          note="Inside the create flow. The primary is “I've saved it”; there is no Cancel."
        >
          <FormFrame
            title="Copy your new API key"
            description={`${newApiKeySecret.name} is ready.`}
            submitLabel="I've saved it"
            cancelLabel={null}
            showClose={false}
            className="w-full"
          >
            <SecretOnce
              value={newApiKeySecret.token}
              details={`${newApiKeySecret.name} · Run sessions · ${newApiKeySecret.expiresLabel}`}
            />
          </FormFrame>
        </StateCell>
        <StateCell
          label="Mobile 390"
          align="stretch"
          width="mobile"
          note="Value and date fold under the name; the menu stays at 44px."
        >
          <VariablesTable policy="write-only" />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "Any credential people give OpenGeni: variables, provider keys, API key creation",
          "Replace value to change a secret; it takes effect from the next turn",
          "Showing a token once, inside the flow that created it",
        ]}
        avoid={[
          "Dots or a last-four preview for saved secrets: they carry no information",
          "Reveal or Copy buttons on saved secrets",
          "Toasts or page notices that show a new token outside its dialog",
        ]}
      />
    </KitSection>
  );
}
