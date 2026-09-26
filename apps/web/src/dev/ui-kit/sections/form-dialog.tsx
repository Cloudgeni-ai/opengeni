import { useEffect, useRef, useState, type ReactNode } from "react";
import { BoxIcon, ClipboardPasteIcon, KeyRoundIcon, PlusIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  CheckboxField,
  Field,
  FieldStack,
  TextArea,
  TextInput,
  useField,
} from "@/components/ui/field";
import { FormDialog, FormFrame, FormInline, FormPage } from "@/components/ui/form-dialog";
import { FormSheet } from "@/components/ui/form-sheet";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { PageHeader } from "@/components/ui/page-header";
import { EnvPastePreview, SecretOnce, parseEnvText } from "@/components/ui/secret-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { SelectMenu } from "@/components/ui/select-menu";
import { cn } from "@/lib/utils";
import { Alternative, Fork, KitBlock, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import {
  apiKeyExpiryOptions,
  apiKeyPresets,
  currentWorkspace,
  defaultApiKeyExpiry,
  newApiKeySecret,
  organization,
  people,
  variableSets,
  type ApiKeyAccess,
  type VariableSetScope,
} from "../fixtures";

/* ----------------------------------------------------------------------------
   Shared content: New variable set.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const SCOPE_OPTIONS: { value: VariableSetScope; label: string }[] = [
  { value: "workspace", label: "Workspace" },
  { value: "organization", label: "Organization" },
  { value: "personal", label: "Only me" },
];

const SCOPE_HINT: Record<VariableSetScope, string> = {
  workspace: `Everyone in ${currentWorkspace.name} can use it. You can't change this later.`,
  organization: `Every workspace in ${organization.name} can use it. You can't change this later.`,
  personal: "Only work you start can use it. You can't change this later.",
};

export interface NewSetValues {
  name: string;
  description: string;
  scope: VariableSetScope;
  env: string;
  showEnv: boolean;
}

const EMPTY_SET: NewSetValues = {
  name: "",
  description: "",
  scope: "workspace",
  env: "",
  showEnv: false,
};

const FILLED_SET: NewSetValues = {
  name: "Sentry",
  description: "Read-only token for the acme-robotics Sentry org.",
  scope: "workspace",
  env: "",
  showEnv: false,
};

function nameError(name: string): string | undefined {
  const trimmed = name.trim();
  if (!trimmed) return "Name the variable set.";
  if (variableSets.some((set) => set.name.toLowerCase() === trimmed.toLowerCase())) {
    return `A variable set named ${trimmed} already exists. Pick another name.`;
  }
  return undefined;
}

function ScopeControl({
  value,
  onChange,
}: {
  value: VariableSetScope;
  onChange: (value: VariableSetScope) => void;
}) {
  const field = useField();
  return (
    <SegmentedControl
      options={SCOPE_OPTIONS}
      value={value}
      onValueChange={onChange}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      className="max-w-full self-start"
    />
  );
}

const NO_ERRORS: { name?: string } = {};

function NewSetFields({
  values,
  onChange,
  errors = NO_ERRORS,
}: {
  values: NewSetValues;
  onChange: (next: NewSetValues) => void;
  errors?: { name?: string };
}) {
  const set = <K extends keyof NewSetValues>(key: K, value: NewSetValues[K]) =>
    onChange({ ...values, [key]: value });
  const rows = values.env.trim() ? parseEnvText(values.env) : [];
  return (
    <FieldStack>
      <Field label="Name" error={errors.name}>
        <TextInput
          value={values.name}
          onChange={(event) => set("name", event.target.value)}
          placeholder="e.g. AWS production"
          suppressAutofill
        />
      </Field>
      <Field label="Description" optional>
        <TextInput
          value={values.description}
          onChange={(event) => set("description", event.target.value)}
          placeholder="What these variables are for"
        />
      </Field>
      <Field label="Available to" group hint={SCOPE_HINT[values.scope]}>
        <ScopeControl value={values.scope} onChange={(scope) => set("scope", scope)} />
      </Field>
      {values.showEnv ? (
        <Field
          label="Variables"
          optional
          hint={
            rows.length ? undefined : "One NAME=value per line. Secrets stay hidden after saving."
          }
        >
          <TextArea
            mono
            rows={4}
            value={values.env}
            onChange={(event) => set("env", event.target.value)}
            placeholder={"SENTRY_ORG=acme-robotics\nSENTRY_AUTH_TOKEN=…"}
            spellCheck={false}
          />
        </Field>
      ) : (
        <div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => set("showEnv", true)}
            className="-ml-2.5 text-fg-muted hover:text-fg pointer-coarse:h-11"
          >
            <ClipboardPasteIcon aria-hidden="true" className="size-4" />
            Paste .env to start with variables
          </Button>
        </div>
      )}
      {rows.length ? <EnvPastePreview rows={rows} /> : null}
    </FieldStack>
  );
}

/** A static, interactive dialog panel for New variable set. */
function NewSetPanel({
  initial = EMPTY_SET,
  initialErrors,
  variant = "dialog",
  pending,
  error,
  submitDisabled,
  disabledReason,
  title = "New variable set",
  className,
}: {
  initial?: NewSetValues;
  initialErrors?: { name?: string };
  variant?: "dialog" | "sheet" | "inline";
  pending?: boolean;
  error?: ReactNode;
  submitDisabled?: boolean;
  disabledReason?: ReactNode;
  title?: ReactNode;
  className?: string;
}) {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState(initialErrors ?? {});
  const props = {
    title,
    description: "Environment variables and secrets your agents get in their sandbox.",
    submitLabel: "Create variable set",
    pendingLabel: "Creating…",
    pending,
    error,
    submitDisabled,
    disabledReason,
    onSubmit: async () => {
      const name = nameError(values.name);
      setErrors({ name });
      if (name) return false;
      await wait(900);
      return true;
    },
    onSubmitted: () => toast.success(`Created ${values.name.trim()}`),
    onCancel: () => {
      setValues(initial);
      setErrors({});
    },
    children: (
      <NewSetFields
        values={values}
        onChange={(next) => {
          setValues(next);
          if (errors.name && next.name !== values.name) setErrors({});
        }}
        errors={errors}
      />
    ),
  };
  if (variant === "inline") return <FormInline {...props} className={className} />;
  return <FormFrame variant={variant} {...props} className={className} />;
}

/** The real modal, for "Open" buttons. */
function NewSetDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [values, setValues] = useState(EMPTY_SET);
  const [errors, setErrors] = useState<{ name?: string }>({});
  const change = (next: boolean) => {
    if (!next) {
      setValues(EMPTY_SET);
      setErrors({});
    }
    onOpenChange(next);
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={change}
      title="New variable set"
      description="Environment variables and secrets your agents get in their sandbox."
      submitLabel="Create variable set"
      pendingLabel="Creating…"
      onSubmit={async () => {
        const name = nameError(values.name);
        setErrors({ name });
        if (name) return false;
        await wait(900);
        if (values.name.trim().toLowerCase() === "offline") {
          throw new Error("Couldn't create the variable set. Check your connection and try again.");
        }
        return true;
      }}
      onSubmitted={() => {
        toast.success(`Created ${values.name.trim()}`);
        change(false);
      }}
    >
      <NewSetFields
        values={values}
        onChange={(next) => {
          setValues(next);
          if (errors.name && next.name !== values.name) setErrors({});
        }}
        errors={errors}
      />
    </FormDialog>
  );
}

/* ----------------------------------------------------------------------------
   Create API key: two steps, the token shown once.
   -------------------------------------------------------------------------- */

const ACCESS_OPTIONS = apiKeyPresets.map((preset) => ({
  value: preset.id,
  label: preset.id === "custom" ? "Custom…" : preset.label,
  description: preset.description,
}));

const EXPIRY_OPTIONS = apiKeyExpiryOptions.map((option) => ({
  value: option.id,
  label: option.label,
  meta:
    option.id === "30d"
      ? "26 Oct 2026"
      : option.id === "90d"
        ? "25 Dec 2026"
        : option.id === "1y"
          ? "26 Sep 2027"
          : undefined,
}));

/** ["Read sessions", "Start sessions"] -> "Read sessions and start sessions." */
function permissionSentence(permissions: string[]): string {
  const lower = permissions.map((permission, index) =>
    index === 0 ? permission : permission.charAt(0).toLowerCase() + permission.slice(1),
  );
  const joined =
    lower.length > 1 ? `${lower.slice(0, -1).join(", ")} and ${lower.at(-1)}` : (lower[0] ?? "");
  return `${joined}.`;
}

function AccessControl({
  value,
  onChange,
}: {
  value: ApiKeyAccess;
  onChange: (value: ApiKeyAccess) => void;
}) {
  const field = useField();
  return (
    <SelectMenu
      options={ACCESS_OPTIONS}
      value={value}
      onValueChange={onChange}
      id={field?.controlId}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      className="w-full"
    />
  );
}

function ExpiryControl({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const field = useField();
  return (
    <SelectMenu
      options={EXPIRY_OPTIONS}
      value={value}
      onValueChange={onChange}
      id={field?.controlId}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      showMetaInTrigger={false}
      className="w-48 max-w-full"
    />
  );
}

export function ApiKeyFields({
  name,
  onNameChange,
  access,
  onAccessChange,
  expiry,
  onExpiryChange,
  nameError: nameMessage,
}: {
  name: string;
  onNameChange: (value: string) => void;
  access: ApiKeyAccess;
  onAccessChange: (value: ApiKeyAccess) => void;
  expiry: string;
  onExpiryChange: (value: string) => void;
  nameError?: string;
}) {
  const preset = apiKeyPresets.find((each) => each.id === access)!;
  const expiryLabel = EXPIRY_OPTIONS.find((option) => option.value === expiry);
  return (
    <FieldStack>
      <Field
        label="Name"
        error={nameMessage}
        hint="Where the key is used, so you know what breaks when you revoke it."
      >
        <TextInput
          value={name}
          onChange={(event) => onNameChange(event.target.value)}
          placeholder="e.g. CI pipeline"
          suppressAutofill
        />
      </Field>
      <Field
        label="Access"
        hint={
          preset.permissions.length
            ? permissionSentence(preset.permissions)
            : "You pick each permission after creating it."
        }
      >
        <AccessControl value={access} onChange={onAccessChange} />
      </Field>
      <Field
        label="Expires"
        hint={expiryLabel?.meta ? `On ${expiryLabel.meta}.` : "The key works until you revoke it."}
      >
        <ExpiryControl value={expiry} onChange={onExpiryChange} />
      </Field>
    </FieldStack>
  );
}

export function ApiKeySecretStep() {
  return (
    <SecretOnce
      value={newApiKeySecret.token}
      details={
        <>
          <span className="font-medium text-fg">{newApiKeySecret.name}</span> · Run sessions ·{" "}
          {newApiKeySecret.expiresLabel}
        </>
      }
    />
  );
}

function CreateApiKeyDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState<"form" | "secret">("form");
  const [name, setName] = useState("");
  const [access, setAccess] = useState<ApiKeyAccess>("run_sessions");
  const [expiry, setExpiry] = useState(defaultApiKeyExpiry);
  const [error, setError] = useState<string>();
  const change = (next: boolean) => {
    if (!next) {
      setStep("form");
      setName("");
      setAccess("run_sessions");
      setExpiry(defaultApiKeyExpiry);
      setError(undefined);
    }
    onOpenChange(next);
  };
  // One dialog for both steps, so the overlay stays put between them. On the
  // one-time step focus moves to Copy, so a second Enter can't close it unseen.
  const secret = step === "secret";
  const secretRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (secret) secretRef.current?.querySelector<HTMLElement>("button")?.focus();
  }, [secret]);
  return (
    <FormDialog
      open={open}
      onOpenChange={change}
      {...(secret
        ? {
            title: "Copy your new API key",
            description: `${name.trim() || newApiKeySecret.name} is ready.`,
            submitLabel: "I've saved it",
            cancelLabel: null,
            showClose: false,
            dismissible: false,
            onSubmitted: () => change(false),
          }
        : {
            title: "Create API key",
            description: `For scripts and CI that work in ${currentWorkspace.name}.`,
            submitLabel: "Create API key",
            pendingLabel: "Creating…",
            onSubmit: async () => {
              if (!name.trim()) {
                setError("Name the key.");
                return false;
              }
              await wait(800);
              return true;
            },
            onSubmitted: () => setStep("secret"),
          })}
    >
      {secret ? (
        <div ref={secretRef}>
          <ApiKeySecretStep />
        </div>
      ) : (
        <ApiKeyFields
          name={name}
          onNameChange={(value) => {
            setName(value);
            setError(undefined);
          }}
          access={access}
          onAccessChange={setAccess}
          expiry={expiry}
          onExpiryChange={setExpiry}
          nameError={error}
        />
      )}
    </FormDialog>
  );
}

/* ----------------------------------------------------------------------------
   New sandbox environment: five fields, so it opens as a sheet.
   -------------------------------------------------------------------------- */

function EnvironmentFields() {
  return (
    <FieldStack>
      <Field label="Name">
        <TextInput placeholder="e.g. Platform CI" defaultValue="Firmware build" suppressAutofill />
      </Field>
      <Field label="Description" optional>
        <TextInput defaultValue="ARM toolchain and the firmware test rig simulator." />
      </Field>
      <Field
        label="Default variable sets"
        group
        optional
        hint="Every new chat in this environment gets them."
      >
        <div className="flex flex-col gap-3 pt-0.5">
          {variableSets.slice(0, 3).map((set, index) => (
            <CheckboxField
              key={set.id}
              label={set.name}
              description={set.description}
              defaultChecked={index === 1}
            />
          ))}
        </div>
      </Field>
      <Field label="Setup script" optional hint="Runs once when the environment is built.">
        <TextArea
          mono
          rows={4}
          defaultValue={"apt-get install -y gcc-arm-none-eabi\nnpm ci --prefix tools/rig-sim"}
          spellCheck={false}
        />
      </Field>
      <Field label="Health check" optional hint="Must exit 0 before a chat starts.">
        <TextInput mono defaultValue="arm-none-eabi-gcc --version" spellCheck={false} />
      </Field>
    </FieldStack>
  );
}

const ENVIRONMENT_FRAME = {
  title: "New sandbox environment",
  description: "A reusable machine setup for chats and schedules.",
  submitLabel: "Create environment",
  pendingLabel: "Creating…",
  footerStart: "Building takes about 2 minutes.",
};

/* ----------------------------------------------------------------------------
   Page backdrops for the fork.
   -------------------------------------------------------------------------- */

function SetsList({ count = 3 }: { count?: number }) {
  return (
    <RowList variant="resource" label="Variable sets">
      {variableSets.slice(0, count).map((set) => (
        <ListRow
          key={set.id}
          leading={<LogoTile icon={<KeyRoundIcon />} name={set.name} />}
          title={set.name}
          description={set.description}
          meta={[set.variablesLabel, set.usageLabel, `Updated ${set.updatedLabel}`]}
          indicator="open"
          onOpen={() => undefined}
        />
      ))}
    </RowList>
  );
}

function SetsHeader({ onNew, active }: { onNew?: () => void; active?: boolean }) {
  return (
    <PageHeader
      title="Variable sets"
      description="Environment variables and secrets your agents get in their sandbox."
      actions={
        <Button
          type="button"
          onClick={onNew}
          aria-expanded={active || undefined}
          className="pointer-coarse:h-11"
        >
          <PlusIcon aria-hidden="true" />
          New variable set
        </Button>
      }
    />
  );
}

function Backdrop({ children, height }: { children: ReactNode; height: number }) {
  return (
    <div className="relative min-w-0 overflow-hidden bg-bg" style={{ height }}>
      {children}
    </div>
  );
}

/** The page behind a scrim: seen, not reachable by keyboard or screen readers. */
function Behind({ children }: { children: ReactNode }) {
  return (
    <div aria-hidden="true" inert>
      {children}
    </div>
  );
}

function Scrim() {
  return <div aria-hidden="true" className="absolute inset-0 bg-black/50" />;
}

/* ----------------------------------------------------------------------------
   The section.
   -------------------------------------------------------------------------- */

export default function FormDialogSection() {
  const [openSet, setOpenSet] = useState(false);
  const [openKey, setOpenKey] = useState(false);
  const [openSheet, setOpenSheet] = useState(false);

  return (
    <KitSection sectionKey="form-dialog">
      <Fork layout="stack">
        <Alternative id="a" padding={false}>
          <Backdrop height={640}>
            <Behind>
              <div className="mx-auto max-w-[960px] px-4 pt-6 sm:px-6">
                <SetsHeader active />
                <div className="mt-6">
                  <SetsList />
                </div>
              </div>
            </Behind>
            <Scrim />
            <div className="absolute inset-x-0 top-10 flex justify-center px-4">
              <NewSetPanel className="w-full max-w-[560px]" />
            </div>
          </Backdrop>
          <div className="border-t border-border">
            <Backdrop height={600}>
              <Behind>
                <div className="mx-auto max-w-[960px] px-4 pt-6 sm:px-6">
                  <PageHeader
                    title="Sandbox environments"
                    description="Reusable machine setups for chats and schedules."
                    actions={
                      <Button type="button" className="pointer-coarse:h-11">
                        <PlusIcon aria-hidden="true" />
                        New environment
                      </Button>
                    }
                  />
                </div>
              </Behind>
              <Scrim />
              <div className="absolute inset-y-0 right-0 flex w-full max-w-[560px] border-l border-border shadow-[var(--og-shadow-lg)]">
                <FormFrame
                  variant="sheet"
                  {...ENVIRONMENT_FRAME}
                  className="w-full"
                  onCancel={() => undefined}
                >
                  <EnvironmentFields />
                </FormFrame>
              </div>
            </Backdrop>
          </div>
          <p className="border-t border-border px-4 py-3 text-xs leading-4.5 text-fg-muted">
            Four fields or fewer open as a dialog. Longer forms, like this five-field environment,
            open as a sheet. Both use the same header, column and footer.
          </p>
        </Alternative>

        <Alternative
          id="b"
          padding={false}
          rationale="Long creates, like a new sandbox environment or schedule, get their own page."
        >
          <Backdrop height={640}>
            <div className="h-full overflow-y-auto">
              <FormPage
                {...ENVIRONMENT_FRAME}
                back={{ label: "Sandbox environments", onClick: () => undefined }}
                onSubmit={() => wait(900)}
                onSubmitted={() => toast.success("Building Firmware build")}
                className="min-h-full"
              >
                <EnvironmentFields />
              </FormPage>
            </div>
          </Backdrop>
          <p className="border-t border-border px-4 py-3 text-xs leading-4.5 text-fg-muted">
            The same five-field environment on its own page, with a footer that stays in view. Short
            forms still open as a dialog. Scroll it: the list is gone until you go back.
          </p>
        </Alternative>

        <Alternative id="c" padding={false}>
          <div className="min-w-0 bg-bg">
            <div className="mx-auto max-w-[960px] px-4 pt-6 pb-6 sm:px-6">
              <SetsHeader active />
              <div className="mt-6">
                <NewSetPanel variant="inline" />
              </div>
              <div className="mt-6">
                <SetsList count={2} />
              </div>
            </div>
          </div>
          <p className="border-t border-border px-4 py-3 text-xs leading-4.5 text-fg-muted">
            Done well: a titled panel with Cancel. It still pushes the list down and competes with
            the page header for attention.
          </p>
        </Alternative>
      </Fork>

      <KitBlock
        title="Open the real thing"
        description="Enter submits. Cmd or Ctrl + Enter submits from a multi-line field. Escape and Cancel close; a click outside never throws away what you typed. Type “offline” as the name to see a server error."
      >
        <div className="flex flex-wrap gap-2">
          <Button type="button" onClick={() => setOpenSet(true)} className="pointer-coarse:h-11">
            <KeyRoundIcon aria-hidden="true" />
            New variable set
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpenKey(true)}
            className="pointer-coarse:h-11"
          >
            Create API key
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => setOpenSheet(true)}
            className="pointer-coarse:h-11"
          >
            <BoxIcon aria-hidden="true" />
            New sandbox environment
          </Button>
        </div>
        <NewSetDialog open={openSet} onOpenChange={setOpenSet} />
        <CreateApiKeyDialog open={openKey} onOpenChange={setOpenKey} />
        <FormSheet
          open={openSheet}
          onOpenChange={setOpenSheet}
          {...ENVIRONMENT_FRAME}
          onSubmit={async () => {
            await wait(900);
          }}
          onSubmitted={() => {
            toast.success("Building Firmware build");
            setOpenSheet(false);
          }}
        >
          <EnvironmentFields />
        </FormSheet>
      </KitBlock>

      <StatesGrid
        columns={2}
        description="The recommended dialog. Every panel is live: type, submit, cancel."
      >
        <StateCell label="Empty" align="stretch">
          <NewSetPanel className="w-full" />
        </StateCell>
        <StateCell label="Filled" align="stretch">
          <NewSetPanel className="w-full" initial={FILLED_SET} />
        </StateCell>
        <StateCell
          label="Invalid"
          align="stretch"
          note="Errors sit under the field, set aria-invalid, and take focus after submit."
        >
          <NewSetPanel
            className="w-full"
            initial={{ ...FILLED_SET, name: "AWS production" }}
            initialErrors={{ name: nameError("AWS production") }}
          />
        </StateCell>
        <StateCell
          label="Loading"
          align="stretch"
          note="Editing waits for the current values. Save stays off until they arrive."
        >
          <FormFrame
            title="Edit GitHub automation"
            description="Name and description. Variables are edited on the set's page."
            submitLabel="Save changes"
            loading
            loadingFields={2}
            className="w-full"
          />
        </StateCell>
        <StateCell label="Submitting" align="stretch">
          <NewSetPanel className="w-full" initial={FILLED_SET} pending />
        </StateCell>
        <StateCell
          label="Server error"
          align="stretch"
          note="What happened and what to do, inside the dialog. Never a raw API message."
        >
          <NewSetPanel
            className="w-full"
            initial={FILLED_SET}
            error="Couldn't create the variable set. Check your connection and try again."
          />
        </StateCell>
        <StateCell
          label="Success · step 2"
          align="stretch"
          note="Shown once. No Cancel or close button, and a click outside doesn't dismiss it."
        >
          <FormFrame
            title="Copy your new API key"
            description={`${newApiKeySecret.name} is ready.`}
            submitLabel="I've saved it"
            cancelLabel={null}
            showClose={false}
            className="w-full"
          >
            <ApiKeySecretStep />
          </FormFrame>
        </StateCell>
        <StateCell
          label="Disabled with reason"
          align="stretch"
          note="Say who can fix it. Hide the entry point instead when nobody on the page can."
        >
          <NewSetPanel
            className="w-full"
            initial={FILLED_SET}
            submitDisabled
            disabledReason={`Only workspace admins can create variable sets. Ask ${people[0]!.name}.`}
          />
        </StateCell>
        <StateCell label="Long text" align="stretch">
          <FormFrame
            title="Replace the value of DATADOG_SYNTHETICS_PRIVATE_LOCATION_WORKER_CONFIG"
            description="Takes effect from the next turn. Turns already running in Monthly access review and Summarize new Sentry errors keep the current value."
            submitLabel="Replace value"
            className="w-full"
          >
            <Field
              label="New value"
              hint="Paste the whole JSON file from Datadog > Synthetics > Private locations > Worker configuration. Line breaks are kept."
            >
              <TextArea mono rows={3} placeholder='{"id": "pl:acme-eu-…"}' />
            </Field>
          </FormFrame>
        </StateCell>
        <StateCell
          label="Mobile 390"
          align="stretch"
          width="mobile"
          padding={false}
          note="A bottom sheet: full width, stacked 44px buttons, safe-area padding."
        >
          <div className="relative flex h-[680px] flex-col justify-end overflow-hidden rounded-[14px] bg-bg">
            <div className="absolute inset-x-0 top-0 px-4 pt-4">
              <PageHeader
                title="Variable sets"
                description="Environment variables and secrets your agents get in their sandbox."
              />
            </div>
            <Scrim />
            <NewSetPanel
              className={cn("relative w-full rounded-b-none border-x-0 border-b-0")}
              initial={FILLED_SET}
            />
          </div>
        </StateCell>
      </StatesGrid>

      <KitBlock
        title="Field"
        description="Label 14/500 bound to the control, an Optional marker, a 12px hint, and an inline error that replaces the hint."
      >
        <div className="grid min-w-0 gap-x-8 gap-y-6 rounded-[14px] border border-border bg-surface p-6 @2xl/kit-section:grid-cols-2">
          <Field label="Name" hint="Shown in the composer and on schedules.">
            <TextInput defaultValue="GitHub automation" />
          </Field>
          <Field label="Description" optional>
            <TextInput placeholder="What these variables are for" />
          </Field>
          <Field
            label="Name"
            error="A variable set named Datadog already exists. Pick another name."
          >
            <TextInput defaultValue="Datadog" />
          </Field>
          <Field
            label="Name"
            disabled
            hint="Organization sets are renamed in organization settings."
          >
            <TextInput defaultValue="Finance exports" />
          </Field>
          <Field label="Setup script" optional hint="Cmd or Ctrl + Enter submits.">
            <TextArea mono rows={3} defaultValue={"npm ci\nnpm run build"} />
          </Field>
          <div className="flex flex-col gap-3">
            <CheckboxField
              label="Skip if still running"
              description="Don't start a new run while the previous one is still working."
              defaultChecked
            />
            <CheckboxField
              label="Notify me when a run fails"
              description="Only for runs you own."
            />
          </div>
        </div>
      </KitBlock>

      <UsageNotes
        use={[
          "Creating or editing one object: a dialog for four fields or fewer",
          "A sheet for longer forms, or when the form needs room for a preview",
          "A second step after submit, like an API key shown once",
        ]}
        avoid={[
          "Settings that save on change: use a switch or a setting row",
          "Confirming a delete: use Destructive confirm",
          "Inline create forms that push the list down",
        ]}
      />
    </KitSection>
  );
}
