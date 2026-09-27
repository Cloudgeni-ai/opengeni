import { useNavigate } from "@tanstack/react-router";
import { RouteIcon, SparklesIcon } from "lucide-react";
import { useCallback, useEffect, useState, type ComponentProps, type SVGProps } from "react";

import { ChatGptMark } from "@/components/chatgpt-mark";
import { Field, TextInput } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { FlushFormPage } from "@/components/ui/flush-form-page";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import type { ModelsView } from "@/lib/models-route";

export type ModelsScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "organization"; workspaceId: string };

/* ----------------------------------------------------------------------------
   Shared pieces of Settings > Models (workspace and organization): provider
   marks, small menus, the flush form page and the URL state that says which
   list, account page or form is showing.
   -------------------------------------------------------------------------- */

export type ModelProviderId = "codex" | "supergrok" | "vercel" | "openrouter";

function VercelMark(props: SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12 3.5 22.5 20.5h-21z" />
    </svg>
  );
}

export function ProviderMark({
  provider,
  className,
}: {
  provider: ModelProviderId;
  className?: string;
}) {
  if (provider === "codex") return <ChatGptMark className={className} />;
  if (provider === "vercel") return <VercelMark className={className} />;
  if (provider === "supergrok") return <SparklesIcon aria-hidden="true" className={className} />;
  return <RouteIcon aria-hidden="true" className={className} />;
}

/** The provider's logo on the shared tile. Size follows the list or page it sits in. */
export function ProviderTile({
  provider,
  size,
}: {
  provider: ModelProviderId;
  size?: LogoTileSize;
}) {
  return <LogoTile size={size} icon={<ProviderMark provider={provider} className="text-fg" />} />;
}

/** A full-page form with a back link and a sticky Cancel + primary footer. */
export function ModelsFormPage({
  backLabel = "Models",
  ...props
}: Omit<ComponentProps<typeof FlushFormPage>, "backLabel"> & { backLabel?: string }) {
  return <FlushFormPage backLabel={backLabel} {...props} />;
}

/**
 * Who pays, in one or two words, for the muted part of a model control:
 * "GPT-6 Astra" + "Codex". API-key models name their provider.
 */
export function payerShortLabel(row: { billingClass: string; providerLabel: string }): string {
  switch (row.billingClass) {
    case "codex_subscription":
      return "Codex";
    case "supergrok_subscription":
      return "SuperGrok";
    case "opengeni_credits":
      return "Credits";
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
    case "supergrok_subscription":
      return "SuperGrok plan";
    case "opengeni_credits":
      return "OpenGeni credits";
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

export function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/* Which page of Settings > Models is showing lives in the URL (lib/models-route). */

export interface ModelsNavigation {
  account: string | undefined;
  view: ModelsView | undefined;
  /** Opens an account's page, or the list with `undefined`. */
  openAccount: (account: string | undefined) => void;
  /** Opens a form page, optionally for an account. */
  openView: (view: ModelsView | undefined, account?: string) => void;
}

export function useModelsNavigation(
  scope: ModelsScope,
  current: { account?: string | undefined; view?: ModelsView | undefined },
): ModelsNavigation {
  const navigate = useNavigate();
  const go = useCallback(
    (search: { account?: string | undefined; view?: ModelsView | undefined }) => {
      const next = {
        section: "models" as const,
        ...(search.account ? { account: search.account } : {}),
        ...(search.view ? { view: search.view } : {}),
      };
      if (scope.kind === "organization") {
        void navigate({
          to: "/workspaces/$workspaceId/organization",
          params: { workspaceId: scope.workspaceId },
          search: next,
        });
      } else {
        void navigate({
          to: "/workspaces/$workspaceId/settings",
          params: { workspaceId: scope.workspaceId },
          search: next,
        });
      }
    },
    [navigate, scope],
  );
  return {
    account: current.account,
    view: current.view,
    openAccount: useCallback((account) => go({ account }), [go]),
    openView: useCallback((view, account) => go({ account, view }), [go]),
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
