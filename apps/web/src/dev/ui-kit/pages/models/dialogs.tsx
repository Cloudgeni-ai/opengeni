import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUpRightIcon, CircleCheckIcon, LoaderCircleIcon } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ChoiceCard, ChoiceCards } from "@/components/ui/choice-cards";
import { CopyField } from "@/components/ui/copy-field";
import {
  DestructiveConfirm,
  showUndoToast,
  type ConfirmDependency,
} from "@/components/ui/destructive-confirm";
import { CheckboxField, Field, FieldStack, TextInput } from "@/components/ui/field";
import { FormDialog, FormInline, FormPage } from "@/components/ui/form-dialog";
import { FormSheet } from "@/components/ui/form-sheet";
import { SecretInput } from "@/components/ui/secret-field";

import { KIT_NOW, currentWorkspace, you } from "../../fixtures";
import { ProviderMark, ProviderTile } from "./marks";
import { useModelsPicks } from "./picks";
import {
  ORG_NAME,
  accountsOf,
  accountsStayConnected,
  effectiveSource,
  findAccount,
  modelChoices,
  modelLabel,
  removeAccount,
  updateAccount,
  updateGateway,
  useModels,
  wait,
  type AllowedTarget,
  type CodexAccount,
  type DetailTarget,
  type GatewayId,
  type ModelChoice,
  type Scope,
} from "./state";

/* ----------------------------------------------------------------------------
   Every dialog the Models page opens. One place renders whichever is open, so
   rows, sheets and menus only say what they want.
   -------------------------------------------------------------------------- */

const GATEWAY_KEYS: Record<GatewayId, { prefix: string; where: string }> = {
  vercel: { prefix: "vck_", where: "Create one in Vercel under AI Gateway, then API keys." },
  openrouter: { prefix: "sk-or-", where: "Create one on openrouter.ai under Keys." },
};

const NEW_ACCOUNT_NAMES = ["design@acme.dev", "support@acme.dev", "data@acme.dev"];

function scopeName(scope: Scope): string {
  return scope === "organization" ? ORG_NAME : currentWorkspace.name;
}

export function ModelsDialogs() {
  const { dialog, openDialog } = useModels();
  const close = () => openDialog(null);
  if (!dialog) return null;
  switch (dialog.kind) {
    case "connect":
      return (
        <ConnectDialog scope={dialog.scope} initialProvider={dialog.provider} onClose={close} />
      );
    case "rename":
      return <RenameDialog scope={dialog.scope} id={dialog.id} onClose={close} />;
    case "redeem":
      return <RedeemDialog scope={dialog.scope} id={dialog.id} onClose={close} />;
    case "disconnect":
      return <DisconnectDialog target={dialog.target} onClose={close} />;
    case "turn-off-codex":
      return <TurnOffCodexDialog onClose={close} />;
    case "replace-key":
      return <KeyDialog scope={dialog.scope} id={dialog.id} mode="replace" onClose={close} />;
    case "add-model":
      return <AddModelDialog scope={dialog.scope} id={dialog.id} onClose={close} />;
  }
}

/* ----------------------------------------------------------------------------
   Connect an account: pick a provider, then sign in or paste a key.
   -------------------------------------------------------------------------- */

type ConnectStep = "provider" | "codex" | "key";

function ConnectDialog({
  scope,
  initialProvider,
  onClose,
}: {
  scope: Scope;
  initialProvider?: "codex" | GatewayId;
  onClose: () => void;
}) {
  const models = useModels();
  const { data, setData, questions, scenario } = models;
  const picks = useModelsPicks();
  const [open, setOpen] = useState(true);
  const [step, setStep] = useState<ConnectStep>(
    initialProvider ? (initialProvider === "codex" ? "codex" : "key") : "provider",
  );
  const [provider, setProvider] = useState<string>(initialProvider ?? "");
  const [providerError, setProviderError] = useState<string | null>(null);
  const [signin, setSignin] = useState<"waiting" | "checking" | "done">("waiting");
  const [useChoice, setUseChoice] = useState("");
  const [useError, setUseError] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const pool = accountsOf(data, scope);
  const newName = NEW_ACCOUNT_NAMES.find((name) => !pool.some((each) => each.name === name));
  const orgPoolInUse =
    scope === "workspace" &&
    questions.q13 === "segmented" &&
    effectiveSource(data, questions, scenario) === "organization";
  const gateways = data.gateways[scope];

  const finish = () => {
    setOpen(false);
    onClose();
  };

  if (step === "key") {
    return (
      <KeyDialog
        scope={scope}
        id={provider as GatewayId}
        mode="connect"
        onClose={finish}
        onBack={initialProvider ? undefined : () => setStep("provider")}
      />
    );
  }

  if (step === "provider") {
    return (
      <FormDialog
        open={open}
        onOpenChange={(next) => (next ? setOpen(true) : finish())}
        title="Connect a model account"
        description={`Pick what pays for new work in ${scopeName(scope)}.`}
        submitLabel="Continue"
        onSubmit={() => {
          if (!provider) {
            setProviderError("Choose a provider to connect.");
            return false;
          }
          setStep(provider === "codex" ? "codex" : "key");
          return false;
        }}
      >
        <ChoiceCards
          aria-label="Provider"
          variant={picks.choice}
          value={provider}
          onValueChange={(value) => {
            setProvider(value);
            setProviderError(null);
          }}
          error={providerError}
        >
          <ChoiceCard
            value="codex"
            icon={<ProviderMark provider="codex" className="size-4" />}
            title="Codex"
            meta="ChatGPT plan"
            description="Pay with a ChatGPT Plus or Pro plan. You sign in with OpenAI; OpenGeni never sees your password."
          />
          {(["vercel", "openrouter"] as const).map((id) => (
            <ChoiceCard
              key={id}
              value={id}
              icon={<ProviderMark provider={id} className="size-4" />}
              title={gateways[id].name}
              meta="API key"
              description={gateways[id].description}
              disabled={gateways[id].connected}
              disabledReason={
                gateways[id].connected
                  ? `Already connected. To change its key, open ${gateways[id].name} in Model accounts.`
                  : undefined
              }
            />
          ))}
        </ChoiceCards>
      </FormDialog>
    );
  }

  // Codex: sign in with a device code, then (if the organization's pool is in
  // use) say which subscriptions new work should use.
  const signedIn = signin === "done";
  const askSource = signedIn && orgPoolInUse;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : finish())}
      leading={<ProviderTile provider="codex" />}
      title="Connect Codex"
      description="Sign in with the ChatGPT account whose plan should pay."
      submitLabel="Add account"
      pendingLabel="Adding…"
      submitDisabled={!signedIn || !newName}
      disabledReason={
        !newName
          ? "This preview has no more sample accounts to add."
          : signedIn
            ? undefined
            : "Finish signing in to ChatGPT first."
      }
      footerStart={
        initialProvider ? null : (
          <Button
            type="button"
            variant="ghost"
            onClick={() => setStep("provider")}
            className="-ml-3 pointer-coarse:h-11"
          >
            Back
          </Button>
        )
      }
      onSubmit={async () => {
        if (askSource && !useChoice) {
          setUseError("Choose which subscriptions new work should use.");
          return false;
        }
        await wait(900);
        const account: CodexAccount = {
          id: `acct-${newName!.split("@")[0]}`,
          name: newName!,
          plan: "ChatGPT Plus",
          scope,
          isPrimary: pool.length === 0,
          useForNewWork: true,
          needsReconnect: false,
          usage: [
            {
              label: "Weekly",
              percentLeft: 100,
              tone: "healthy",
              resetsLabel: "Sat 3 Oct, 13:48",
            },
            { label: "5-hour", percentLeft: 100, tone: "healthy", resetsLabel: "Today, 18:48" },
          ],
          resets: [],
          checkedAt: KIT_NOW,
          codexApps: false,
          modelsServed: "all",
          connectedBy: you.name,
          connectedOn: "26 Sep 2026",
          accountId: `chatgpt-acct-${newName!.length.toString(16)}e21f0b8`,
          availability:
            scope === "organization"
              ? { allShared: true, workspaces: [], personal: true }
              : undefined,
        };
        setData((value) => {
          const next =
            scope === "organization"
              ? { ...value, orgAccounts: [...value.orgAccounts, account] }
              : { ...value, workspaceAccounts: [...value.workspaceAccounts, account] };
          return askSource && useChoice === "workspace" ? { ...next, source: "workspace" } : next;
        });
        toast.success(`Added ${account.name}`, {
          description:
            askSource && useChoice === "organization"
              ? `New work keeps using subscriptions from ${ORG_NAME} until you switch.`
              : undefined,
        });
      }}
      onSubmitted={finish}
    >
      <FieldStack>
        <ol className="flex min-w-0 flex-col gap-5">
          <Step number={1} title="Open ChatGPT and sign in">
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                if (signin !== "waiting") return;
                setSignin("checking");
                timer.current = window.setTimeout(() => setSignin("done"), 2200);
              }}
              className="mt-2 rounded-[10px] pointer-coarse:h-11"
            >
              Open ChatGPT
              <ArrowUpRightIcon aria-hidden="true" />
            </Button>
          </Step>
          <Step number={2} title="Enter this code when ChatGPT asks for it">
            <CopyField
              value="KQ4M-7TZP"
              label="sign-in code"
              variant="field"
              size="md"
              className="mt-2 max-w-60"
            />
          </Step>
        </ol>
        <p
          role="status"
          className="flex min-w-0 items-center gap-2 rounded-[10px] bg-surface-2 px-3 py-2.5 text-sm text-fg-muted"
        >
          {signedIn ? (
            <>
              <CircleCheckIcon aria-hidden="true" className="size-4 shrink-0 text-status-idle" />
              <span className="min-w-0">
                Signed in as <span className="font-medium text-fg">{newName}</span> · ChatGPT Plus
              </span>
            </>
          ) : (
            <>
              <LoaderCircleIcon
                aria-hidden="true"
                className="size-4 shrink-0 text-fg-subtle motion-safe:animate-spin"
              />
              <span className="min-w-0">
                {signin === "checking" ? "Checking your sign-in…" : "Waiting for you to sign in…"}
              </span>
            </>
          )}
        </p>
        {askSource ? (
          <ChoiceCards
            variant={picks.choice}
            label="Use this account instead of the organization's subscriptions?"
            description={`New work in ${currentWorkspace.name} uses one or the other, never both.`}
            value={useChoice}
            onValueChange={(value) => {
              setUseChoice(value);
              setUseError(null);
            }}
            error={useError}
          >
            <ChoiceCard
              value="workspace"
              title="Use this account"
              description={`New work here switches to this workspace's accounts and stops using subscriptions from ${ORG_NAME}.`}
            />
            <ChoiceCard
              value="organization"
              title="Keep the organization's subscriptions"
              description="This account stays connected but isn't used until you switch."
            />
          </ChoiceCards>
        ) : null}
      </FieldStack>
    </FormDialog>
  );
}

function Step({ number, title, children }: { number: number; title: string; children: ReactNode }) {
  return (
    <li className="flex min-w-0 gap-3">
      <span
        aria-hidden="true"
        className="grid size-6 shrink-0 place-items-center rounded-full border border-border bg-surface-2 text-xs font-medium text-fg-muted"
      >
        {number}
      </span>
      <div className="min-w-0 flex-1 pt-0.5">
        <p className="text-sm font-medium text-fg">{title}</p>
        {children}
      </div>
    </li>
  );
}

/* ----------------------------------------------------------------------------
   API keys: connect or replace.
   -------------------------------------------------------------------------- */

function KeyDialog({
  scope,
  id,
  mode,
  onClose,
  onBack,
}: {
  scope: Scope;
  id: GatewayId;
  mode: "connect" | "replace";
  onClose: () => void;
  onBack?: () => void;
}) {
  const { data, setData } = useModels();
  const gateway = data.gateways[scope][id];
  const [open, setOpen] = useState(true);
  const [key, setKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const rules = GATEWAY_KEYS[id];
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      size="sm"
      leading={<ProviderTile provider={id} />}
      title={mode === "connect" ? `Connect ${gateway.name}` : `Replace the ${gateway.name} key`}
      description={
        mode === "connect"
          ? gateway.description
          : "New work uses the new key right away. Work already running finishes on the old one."
      }
      submitLabel={mode === "connect" ? `Connect ${gateway.name}` : "Replace key"}
      pendingLabel="Checking key…"
      footerStart={
        onBack ? (
          <Button
            type="button"
            variant="ghost"
            onClick={onBack}
            className="-ml-3 pointer-coarse:h-11"
          >
            Back
          </Button>
        ) : null
      }
      onSubmit={async () => {
        const trimmed = key.trim();
        if (!trimmed) {
          setError(`Paste your ${gateway.name} API key.`);
          return false;
        }
        if (trimmed.length < 20) {
          setError(`This key looks too short. Copy the whole key from ${gateway.name}.`);
          return false;
        }
        await wait(1000);
        if (!trimmed.startsWith(rules.prefix)) {
          throw new Error(
            `${gateway.name} didn't accept this key. Keys from ${gateway.name} start with ${rules.prefix}.`,
          );
        }
        setData((value) =>
          updateGateway(value, scope, id, {
            connected: true,
            keyHint: trimmed.slice(-4),
            connectedOn: "26 Sep 2026",
            customModels: mode === "connect" ? [] : gateway.customModels,
          }),
        );
        toast.success(mode === "connect" ? `Connected ${gateway.name}` : "Key replaced");
      }}
      onSubmitted={close}
    >
      <Field
        label="API key"
        hint={`${rules.where} It's stored encrypted and never shown again.`}
        error={error}
      >
        <SecretInput
          value={key}
          placeholder={`${rules.prefix}…`}
          onChange={(event) => {
            setKey(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}

const MODEL_ID = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:-]*$/i;

function AddModelDialog({
  scope,
  id,
  onClose,
}: {
  scope: Scope;
  id: GatewayId;
  onClose: () => void;
}) {
  const { data, setData } = useModels();
  const gateway = data.gateways[scope][id];
  const [open, setOpen] = useState(true);
  const [slug, setSlug] = useState("");
  const [error, setError] = useState<string | null>(null);
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      size="sm"
      title={`Add a model from ${gateway.name}`}
      description="Agents can pick it for new work, billed to this key."
      submitLabel="Add model"
      pendingLabel="Adding…"
      onSubmit={async () => {
        const value = slug.trim();
        if (!value) {
          setError("Enter a model ID.");
          return false;
        }
        if (!MODEL_ID.test(value)) {
          setError("Use the provider/model form, for example mistralai/mistral-large-2411.");
          return false;
        }
        if (gateway.customModels.includes(value)) {
          setError(`${value} is already on this key.`);
          return false;
        }
        await wait(700);
        setData((current) =>
          updateGateway(current, scope, id, { customModels: [...gateway.customModels, value] }),
        );
        toast.success(`Added ${value}`);
      }}
      onSubmitted={close}
    >
      <Field
        label="Model ID"
        hint={`Copy it from the model's page on ${gateway.name}.`}
        error={error}
      >
        <TextInput
          mono
          suppressAutofill
          value={slug}
          placeholder="mistralai/mistral-large-2411"
          onChange={(event) => {
            setSlug(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}

/* ----------------------------------------------------------------------------
   Account actions: rename, redeem a reset, disconnect, turn Codex off.
   -------------------------------------------------------------------------- */

function RenameDialog({ scope, id, onClose }: { scope: Scope; id: string; onClose: () => void }) {
  const { data, setData } = useModels();
  const account = findAccount(data, scope, id);
  const [open, setOpen] = useState(true);
  const [name, setName] = useState(account?.name ?? "");
  const [error, setError] = useState<string | null>(null);
  if (!account) return null;
  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      size="sm"
      title="Rename account"
      description="Shown in this list and the model picker. The ChatGPT login stays the same."
      submitLabel="Save name"
      pendingLabel="Saving…"
      onSubmit={async () => {
        const value = name.trim();
        if (!value) {
          setError("Enter a name.");
          return false;
        }
        if (value.length > 64) {
          setError("Keep it to 64 characters or fewer.");
          return false;
        }
        if (accountsOf(data, scope).some((each) => each.id !== id && each.name === value)) {
          setError(`Another account here is already called ${value}.`);
          return false;
        }
        await wait(600);
        setData((current) => updateAccount(current, scope, id, { name: value }));
        toast.success("Name saved");
      }}
      onSubmitted={close}
    >
      <Field label="Name" error={error} aside={`${name.trim().length}/64`}>
        <TextInput
          suppressAutofill
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(null);
          }}
        />
      </Field>
    </FormDialog>
  );
}

function RedeemDialog({ scope, id, onClose }: { scope: Scope; id: string; onClose: () => void }) {
  const { data, setData } = useModels();
  const account = findAccount(data, scope, id);
  const [open, setOpen] = useState(true);
  if (!account) return null;
  const weekly = account.usage.find((window) => window.label === "Weekly");
  const close = () => {
    setOpen(false);
    onClose();
  };
  const left = account.resets.length - 1;
  return (
    <FormDialog
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      size="sm"
      title="Redeem a usage limit reset?"
      description={`${account.name} gets a fresh weekly limit now. A reset can only be used once.`}
      submitLabel="Redeem reset"
      pendingLabel="Redeeming…"
      initialFocus="cancel"
      onSubmit={async () => {
        await wait(900);
        setData((current) =>
          updateAccount(current, scope, id, (value) => ({
            resets: value.resets.slice(1),
            checkedAt: KIT_NOW,
            usage: value.usage.map((window) =>
              window.label === "Weekly"
                ? { ...window, percentLeft: 100, tone: "healthy", resetsLabel: "Sat 3 Oct, 13:48" }
                : window,
            ),
          })),
        );
        toast.success(`Weekly limit reset for ${account.name}`);
      }}
      onSubmitted={close}
    >
      <dl className="m-0 grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-2 text-sm">
        <dt className="text-fg-muted">Weekly now</dt>
        <dd className="m-0 text-fg">
          {weekly?.percentLeft ?? 0}% left
          {weekly?.resetsLabel ? (
            <span className="text-fg-subtle"> · resets {weekly.resetsLabel}</span>
          ) : null}
        </dd>
        <dt className="text-fg-muted">After</dt>
        <dd className="m-0 text-fg">100% left</dd>
        <dt className="text-fg-muted">Resets left</dt>
        <dd className="m-0 text-fg">{left}</dd>
      </dl>
    </FormDialog>
  );
}

function DisconnectDialog({ target, onClose }: { target: DetailTarget; onClose: () => void }) {
  const models = useModels();
  const { data, setData, questions, scenario, openDetail } = models;
  const picks = useModelsPicks();
  const [open, setOpen] = useState(true);
  const close = () => {
    setOpen(false);
    onClose();
  };

  let name: string;
  let consequences: ReactNode[];
  let dependencies: ConfirmDependency[] = [];
  if (target.kind === "codex") {
    const account = findAccount(data, target.scope, target.id);
    if (!account) return null;
    name = account.name;
    const rest = accountsOf(data, target.scope).filter((each) => each.id !== account.id);
    const others = rest.filter((each) => each.useForNewWork && !each.needsReconnect);
    const paused = rest.filter((each) => !each.useForNewWork);
    const inUse =
      target.scope === "organization" ||
      effectiveSource(data, questions, scenario) === target.scope;
    consequences = [
      target.scope === "organization"
        ? `Workspaces that use ${name} stop using it for new work.`
        : `${name} stops paying for new work in ${currentWorkspace.name}.`,
      !inUse
        ? `New work keeps using subscriptions from ${ORG_NAME}.`
        : others.length > 0
          ? `New work moves to ${others.map((each) => each.name).join(" and ")}.`
          : paused.length > 0
            ? `New Codex work waits until you turn ${paused.map((each) => each.name).join(" or ")} back on, or connect another account.`
            : "New Codex work waits until you connect another account.",
      "Work already running finishes first.",
    ];
    if (account.resets.length > 0) {
      consequences.push(
        `Its ${account.resets.length} usage limit ${account.resets.length === 1 ? "reset" : "resets"} can't be redeemed after this.`,
      );
    }
  } else {
    const gateway = data.gateways[target.scope][target.id];
    name = gateway.name;
    consequences = [
      gateway.customModels.length > 0
        ? `Its ${gateway.customModels.length} custom models stop working for new work.`
        : `Models billed to ${name} stop working for new work.`,
      "Work already running finishes first.",
      "The key is deleted. You'll need a new one to reconnect.",
    ];
    const choices = modelChoices(data, questions, scenario);
    const defaultChoice = choices.find((each) => each.id === data.defaultModelId);
    const payer = target.id === "openrouter" ? "OpenRouter" : "AI Gateway";
    if (target.scope === "workspace" && defaultChoice?.payer === payer) {
      dependencies = [
        {
          id: "default-model",
          kind: "workspace",
          kindLabel: "Default model",
          name: modelLabel(choices, data.defaultModelId),
          detail: `${currentWorkspace.name} settings`,
        },
      ];
    }
  }

  const blocked = dependencies.length > 0;
  return (
    <DestructiveConfirm
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      variant={blocked ? "blocked" : picks.destructive}
      title={blocked ? `${name} is in use` : `Disconnect ${name}?`}
      description={blocked ? "Pick another default model first, then disconnect." : undefined}
      consequences={consequences}
      dependencies={dependencies}
      dependenciesTitle="Used by"
      confirmText={name}
      confirmLabel="Disconnect"
      pendingLabel="Disconnecting…"
      onConfirm={async () => {
        await wait(900);
        setData((current) =>
          target.kind === "codex"
            ? removeAccount(current, target.scope, target.id)
            : updateGateway(current, target.scope, target.id, {
                connected: false,
                keyHint: undefined,
                customModels: [],
              }),
        );
        openDetail(null);
        toast.success(`Disconnected ${name}`);
      }}
    />
  );
}

function TurnOffCodexDialog({ onClose }: { onClose: () => void }) {
  const { data, setData } = useModels();
  const picks = useModelsPicks();
  const [open, setOpen] = useState(true);
  const count = data.workspaceAccounts.length;
  const turnOff = () => setData((value) => ({ ...value, codexEnabled: false }));

  // "Undo instead": turning Codex off is reversible, so it happens at once.
  useEffect(() => {
    if (!picks.destructiveUndo) return;
    turnOff();
    showUndoToast({
      title: `Codex is off in ${currentWorkspace.name}`,
      description: "Accounts stay connected.",
      onUndo: () => setData((value) => ({ ...value, codexEnabled: true })),
    });
    onClose();
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- runs once when the dialog opens
  }, []);
  if (picks.destructiveUndo) return null;

  const close = () => {
    setOpen(false);
    onClose();
  };
  return (
    <DestructiveConfirm
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      variant={picks.destructive}
      title={`Turn off Codex in ${currentWorkspace.name}?`}
      consequences={[
        "New chats and schedules here can't use Codex models.",
        "Work already running finishes first.",
        `${accountsStayConnected(count)} Turn Codex back on any time.`,
      ]}
      confirmText="Codex"
      confirmLabel="Turn off Codex"
      pendingLabel="Turning off…"
      onConfirm={async () => {
        await wait(700);
        turnOff();
        toast.success(`Codex is off in ${currentWorkspace.name}`);
      }}
    />
  );
}

/* ----------------------------------------------------------------------------
   Allowed models: the workspace list, or what one account can serve.
   -------------------------------------------------------------------------- */

function targetTitle(target: AllowedTarget, accountName: string | undefined): string {
  return target.kind === "workspace" ? "Allowed models" : `Models ${accountName ?? ""} can serve`;
}

function useAllowedForm(target: AllowedTarget) {
  const { data, setData, questions, scenario } = useModels();
  const choices = modelChoices(data, questions, scenario);
  let options: ModelChoice[];
  let current: "all" | string[];
  let name: string | undefined;
  if (target.kind === "workspace") {
    options = choices;
    current = data.allowedModels;
  } else if (target.id === "openrouter" || target.id === "vercel") {
    const gateway = data.gateways[target.scope][target.id];
    name = gateway.name;
    current = gateway.modelsServed;
    options = gateway.customModels.map((slug) => ({
      id: `${target.id}:${slug}`,
      label: slug,
      payer: gateway.name,
      group: gateway.name,
      available: true,
    }));
  } else {
    const account = findAccount(data, target.scope, target.id);
    name = account?.name;
    current = account?.modelsServed ?? "all";
    options = choices.filter((choice) => choice.group === "Codex plan");
  }
  const save = (value: "all" | string[]) => {
    setData((state) => {
      if (target.kind === "workspace") return { ...state, allowedModels: value };
      if (target.id === "openrouter" || target.id === "vercel") {
        return updateGateway(state, target.scope, target.id, { modelsServed: value });
      }
      return updateAccount(state, target.scope, target.id, { modelsServed: value });
    });
  };
  return { options, current, name, save, defaultModelId: data.defaultModelId, choices };
}

export function AllowedModelsForm({
  target,
  presentation,
  onClose,
}: {
  target: AllowedTarget;
  presentation: "sheet" | "page" | "inline";
  onClose: () => void;
}) {
  const picks = useModelsPicks();
  const form = useAllowedForm(target);
  const [open, setOpen] = useState(true);
  const [mode, setMode] = useState<"all" | "only">(form.current === "all" ? "all" : "only");
  const [selected, setSelected] = useState<string[]>(
    form.current === "all" ? form.options.map((option) => option.id) : form.current,
  );
  const [error, setError] = useState<string | null>(null);
  const workspace = target.kind === "workspace";
  const groups = Array.from(new Set(form.options.map((option) => option.group)));
  const close = () => {
    setOpen(false);
    onClose();
  };

  const onSubmit = async () => {
    if (mode === "only") {
      if (selected.length === 0) {
        setError(
          workspace
            ? "Pick at least one model, or allow all models."
            : "Pick at least one model, or let it serve all models.",
        );
        return false;
      }
      if (workspace && !selected.includes(form.defaultModelId)) {
        setError(
          `${modelLabel(form.choices, form.defaultModelId)} is the default model. Keep it allowed, or change the default model first.`,
        );
        return false;
      }
    }
    await wait(800);
    form.save(mode === "all" ? "all" : selected);
    toast.success(workspace ? "Allowed models saved" : "Models saved");
  };

  const body = (
    <FieldStack>
      <ChoiceCards
        variant={picks.choice}
        label={workspace ? "New work can use" : "This account can serve"}
        value={mode}
        onValueChange={(value) => {
          setMode(value as "all" | "only");
          setError(null);
        }}
      >
        <ChoiceCard
          value="all"
          title={workspace ? "All models from connected accounts" : "All models"}
          description={
            workspace
              ? "Includes models from accounts connected later."
              : "Includes models the provider adds later."
          }
        />
        <ChoiceCard
          value="only"
          title="Only the models I choose"
          description="New models stay off until you add them here."
        />
      </ChoiceCards>
      {mode === "only" ? (
        <div role="group" aria-label="Models" className="flex min-w-0 flex-col gap-5">
          {groups.map((group) => (
            <fieldset key={group} className="m-0 min-w-0 border-0 p-0">
              <legend className="mb-2 text-xs leading-4.5 font-medium text-fg-subtle">
                {group}
              </legend>
              <div className="flex min-w-0 flex-col gap-3">
                {form.options
                  .filter((option) => option.group === group)
                  .map((option) => (
                    <CheckboxField
                      key={option.id}
                      label={
                        // Custom models are provider/model IDs: mono, like every ID.
                        option.label.includes("/") ? (
                          <span className="font-mono text-xs">{option.label}</span>
                        ) : (
                          option.label
                        )
                      }
                      description={
                        option.available
                          ? option.description
                          : [
                              option.description,
                              `Can't run right now: ${option.unavailableReason ?? "unavailable"}`,
                            ]
                              .filter(Boolean)
                              .join(" ")
                      }
                      checked={selected.includes(option.id)}
                      onCheckedChange={(checked) => {
                        setError(null);
                        setSelected((value) =>
                          checked
                            ? [...value, option.id]
                            : value.filter((each) => each !== option.id),
                        );
                      }}
                    />
                  ))}
              </div>
            </fieldset>
          ))}
          {form.options.length === 0 ? (
            <p className="text-sm text-fg-muted">
              No models yet. Add a custom model to the key first.
            </p>
          ) : null}
        </div>
      ) : null}
    </FieldStack>
  );

  const common = {
    title: targetTitle(target, form.name),
    description: workspace
      ? `Which models new work in ${currentWorkspace.name} may use. People can still pick any allowed model.`
      : `Workspaces in ${ORG_NAME} can only use it for these models.`,
    submitLabel: "Save",
    pendingLabel: "Saving…",
    error,
    onSubmit,
    children: body,
  };

  if (presentation === "page") {
    return (
      <FormPage
        {...common}
        back={{ label: "Models", onClick: onClose }}
        onCancel={onClose}
        onSubmitted={onClose}
      />
    );
  }
  if (presentation === "inline") {
    return <FormInline {...common} onCancel={onClose} onSubmitted={onClose} />;
  }
  return (
    <FormSheet
      open={open}
      onOpenChange={(next) => (next ? setOpen(true) : close())}
      {...common}
      onSubmitted={close}
    />
  );
}
