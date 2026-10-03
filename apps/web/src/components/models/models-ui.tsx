import type { ModelConnectionAccessResponse } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ComponentProps,
} from "react";

import { Field, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { userErrorText } from "@/lib/api-error";
import type { ModelsView } from "@/lib/models-route";
import { returnToSearch, type ReturnTo } from "@/lib/return-to";

/**
 * Where a Models page lives: Organization settings > Models, opened through
 * `anchorWorkspaceId` (the settings URL's workspace), and the workspace whose
 * model page it is or was opened from, if any (`?workspace=`).
 */
export type ModelsScope = {
  anchorWorkspaceId: string;
  workspaceId?: string | undefined;
};

/* ----------------------------------------------------------------------------
   Shared pieces of Organization settings > Models: provider marks, small
   menus, the flush form page and the URL state that says which list, account
   page or form is showing.
   -------------------------------------------------------------------------- */

/**
 * The name of the list a sub-page's back link returns to: "Models", or the
 * workspace's name for pages opened from a workspace's model page.
 */
const ModelsListLabelContext = createContext("Models");
export const ModelsListLabelProvider = ModelsListLabelContext.Provider;
export function useModelsListLabel(): string {
  return useContext(ModelsListLabelContext);
}

// The provider logos live in their own light module so the onboarding model
// step can show them without the Models page graph.
export { ProviderMark, ProviderTile, type ModelProviderId } from "./provider-mark";

/**
 * Who an account is for, as the one tag on its row and page: the
 * organization's workspaces (all, or the ones it was limited to), this
 * workspace, or only the person who connected it.
 */
export interface ModelsScopeLabels {
  /** "Shared by Acme": an organization account whose "Available in" this viewer can't read. */
  organization: string;
  /** "Everyone in Acme": an organization account every workspace can use. */
  everyone: string;
  /** "Selected workspaces": an organization account limited to some workspaces. */
  selected: string;
  /** "Design preview only", "This workspace only", or "Personal workspace only". */
  workspace: string;
  /** "Only you". */
  user: string;
}

export function modelsScopeLabels(
  organizationName: string,
  personal: boolean,
  /** Names the workspace in its own accounts' tag ("Design preview only"). */
  workspaceName?: string,
): ModelsScopeLabels {
  return {
    organization: `Shared by ${organizationName}`,
    everyone: `Everyone in ${organizationName}`,
    selected: "Selected workspaces",
    workspace: personal
      ? "Personal workspace only"
      : workspaceName
        ? `${workspaceName} only`
        : "This workspace only",
    user: "Only you",
  };
}

/**
 * The tag of an organization account, from its "Available in": everyone, or
 * selected workspaces. "Shared by Acme" until the policy is known.
 */
export function organizationReachLabel(
  labels: ModelsScopeLabels,
  access: ModelConnectionAccessResponse | null | undefined,
): string {
  if (!access) return labels.organization;
  const { policy, personalWorkspacesSupported } = access;
  return policy.allowedWorkspaces === null &&
    (!personalWorkspacesSupported || policy.allowPersonalWorkspaces)
    ? labels.everyone
    : labels.selected;
}

/** "Not in use", in the usage column of an account new work here doesn't use. */
export const NOT_IN_USE = <span className="text-xs font-medium text-fg-subtle">Not in use</span>;

/** A full-page form with a back link and a sticky Cancel + primary footer. */
export function ModelsFormPage({
  backLabel,
  ...props
}: Omit<ComponentProps<typeof FlushFormPage>, "backLabel"> & {
  backLabel?: string;
}) {
  const listLabel = useModelsListLabel();
  return <FlushFormPage backLabel={backLabel ?? listLabel} {...props} />;
}

/**
 * Who pays, in one or two words, for the muted part of a model control:
 * "GPT-6 Astra" + "Codex". API-key models name their provider.
 */
export function payerShortLabel(row: { billingClass: string; providerLabel: string }): string {
  switch (row.billingClass) {
    case "codex_subscription":
      return "Codex";
    case "claude_subscription":
      return "Claude";
    case "supergrok_subscription":
      return "SuperGrok";
    case "opengeni_credits":
      return "Opengeni credits";
    case "byok":
    case "organization_byok":
      return row.providerLabel;
    default:
      return row.providerLabel;
  }
}

/** Who pays for a model, in product words: "Codex plan", "OpenGeni credits". */
export function payerLabel(billingClass: string, fallback?: string): string {
  switch (billingClass) {
    case "codex_subscription":
      return "Codex plan";
    case "claude_subscription":
      return "Claude plan";
    case "supergrok_subscription":
      return "SuperGrok plan";
    case "opengeni_credits":
      return "Opengeni credits";
    case "byok":
      return "Workspace API key";
    case "organization_byok":
      return "Organization API key";
    default:
      return fallback ?? "Provider account";
  }
}

/** "3 usage limit resets", or nothing. */
export function resetsLabel(count: number | null | undefined): string | null {
  if (typeof count !== "number" || count <= 0) return null;
  return count === 1 ? "1 usage limit reset" : `${count} usage limit resets`;
}

/** One line for a failed action: advice for an API error, never its raw message. */
export function errorText(error: unknown, fallback: string): string {
  return userErrorText(error, fallback);
}

/* Which page of Organization settings > Models is showing lives in the URL (lib/models-route). */

export interface ModelsNavigation {
  account: string | undefined;
  view: ModelsView | undefined;
  /**
   * Where this page was opened from in another scope. It stays in the URL
   * while an account and its forms are open; the list drops it.
   */
  returnTo: ReturnTo | undefined;
  /** Opens an account's page, or the list with `undefined`. `from` crosses scopes. */
  openAccount: (account: string | undefined, from?: ReturnTo) => void;
  /** Opens a form page, optionally for an account. */
  openView: (view: ModelsView | undefined, account?: string) => void;
  /** Opens a workspace's model page, or the organization's list with `undefined`. */
  openWorkspace: (workspaceId: string | undefined, account?: string, view?: ModelsView) => void;
  /** Returns to where a cross-scope link came from. */
  goBack: (returnTo: ReturnTo) => void;
}

export function useModelsNavigation(
  scope: ModelsScope,
  current: {
    account?: string | undefined;
    view?: ModelsView | undefined;
    returnTo?: ReturnTo | undefined;
  },
): ModelsNavigation {
  const navigate = useNavigate();
  const currentReturnTo = current.returnTo;
  const go = useCallback(
    (search: {
      account?: string | undefined;
      view?: ModelsView | undefined;
      from?: ReturnTo | undefined;
      /** Null leaves the workspace page for the organization's list. */
      workspace?: string | null | undefined;
    }) => {
      const from = search.from ?? (search.account ? currentReturnTo : undefined);
      const workspace = search.workspace === undefined ? scope.workspaceId : search.workspace;
      const next = {
        section: "models" as const,
        ...(workspace ? { workspace } : {}),
        ...(search.account ? { account: search.account } : {}),
        ...(search.view ? { view: search.view } : {}),
        ...returnToSearch(from),
      };
      void navigate({
        to: "/workspaces/$workspaceId/organization",
        params: { workspaceId: scope.anchorWorkspaceId },
        search: next,
      });
    },
    [navigate, scope.anchorWorkspaceId, scope.workspaceId, currentReturnTo],
  );
  return {
    account: current.account,
    view: current.view,
    returnTo: currentReturnTo,
    openAccount: useCallback((account, from) => go({ account, from }), [go]),
    openView: useCallback((view, account) => go({ account, view }), [go]),
    openWorkspace: useCallback(
      (workspace, account, view) => go({ workspace: workspace ?? null, account, view }),
      [go],
    ),
    goBack: useCallback((returnTo) => void navigate({ href: returnTo.path }), [navigate]),
  };
}

/** Rename an account: a one-field prompt. `onSave` throws a user-facing error. */
export function RenameAccountDialog({
  open,
  onOpenChange,
  name,
  label,
  provider,
  onSave,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name shown today. */
  name: string;
  /** The saved label (empty when the name falls back to the email). */
  label: string | null | undefined;
  provider: string;
  onSave: (label: string) => Promise<void>;
}) {
  const [value, setValue] = useState(label ?? "");
  useEffect(() => {
    if (open) setValue(label ?? "");
  }, [open, label]);
  const tooLong = value.trim().length > 64;
  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      size="sm"
      title="Rename account"
      description={`Shown in this list and the model picker. The ${provider} sign-in stays the same.`}
      submitLabel="Save name"
      pendingLabel="Saving…"
      submitDisabled={tooLong}
      onSubmit={async () => {
        await onSave(value);
      }}
      onSubmitted={() => onOpenChange(false)}
    >
      <Field
        label="Name"
        hint={`Leave empty to show ${name === label ? "the account's email" : name}.`}
        error={tooLong ? "Use 64 characters or fewer." : undefined}
        aside={`${value.trim().length}/64`}
      >
        <TextInput
          value={value}
          suppressAutofill
          onChange={(event) => setValue(event.target.value)}
        />
      </Field>
    </FormDialog>
  );
}
