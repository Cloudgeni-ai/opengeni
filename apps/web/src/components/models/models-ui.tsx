import { useNavigate } from "@tanstack/react-router";
import { MoreHorizontalIcon, RouteIcon, SparklesIcon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
  type SVGProps,
} from "react";

import { ChatGptMark } from "@/components/chatgpt-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Field, TextInput } from "@/components/ui/field";
import { FormDialog, FormPage, type FormFrameProps } from "@/components/ui/form-dialog";
import { HelpTip } from "@/components/ui/inline-help";
import { LogoTile, type LogoTileSize } from "@/components/ui/logo-tile";
import { useRowListVariant } from "@/components/ui/list-row";
import type { ModelsView } from "@/lib/models-route";
import { cn } from "@/lib/utils";

export type ModelsScope =
  | { kind: "workspace"; workspaceId: string }
  | { kind: "organization"; workspaceId: string };

/* ----------------------------------------------------------------------------
   Shared pieces of Settings > Models (workspace and organization): provider
   marks, the provider group header, small menus, the flush form page and the
   URL state that says which list, account page or form is showing.
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

/** "Codex · ChatGPT plan" over a group of rows, with pool-wide controls under it. */
export function ProviderGroupHeader({
  title,
  subtitle,
  trailing,
  controls,
  note,
  first = false,
}: {
  title: string;
  subtitle: string;
  /** The group's one action (⋯ menu, or "Turn on Codex"), at the row's end. */
  trailing?: ReactNode;
  /** Pool-wide choices ("Use", "Pick"), on their own line under the title. */
  controls?: ReactNode;
  note?: ReactNode;
  /** The first group in the section sits closer to the section's title. */
  first?: boolean;
}) {
  const variant = useRowListVariant();
  return (
    <li className="col-span-full min-w-0 list-none">
      <div
        className={cn(
          "min-w-0 px-3",
          first ? "pt-1" : "pt-5",
          variant === "catalog" ? "pb-1" : "pb-3",
        )}
      >
        <div className="flex min-w-0 items-center justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-sm leading-5 font-semibold text-fg">{title}</h3>
            <p className="text-xs leading-4.5 text-fg-muted">{subtitle}</p>
          </div>
          {trailing ? (
            <div className="flex shrink-0 items-center empty:hidden">{trailing}</div>
          ) : null}
        </div>
        {controls ? (
          <div className="mt-3 flex min-w-0 flex-wrap items-center gap-x-6 gap-y-2 empty:hidden">
            {controls}
          </div>
        ) : null}
        {note ? <div className="mt-2 min-w-0 empty:hidden">{note}</div> : null}
      </div>
    </li>
  );
}

/** A small label, an optional help tip, and one control, as they sit in a group header. */
export function LabelledControl({
  label,
  help,
  children,
}: {
  label: string;
  help?: string;
  children: (labelId: string) => ReactNode;
}) {
  const labelId = useId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 shrink-0 items-center gap-2 @max-[479px]/list:w-14">
        <span id={labelId} className="text-xs leading-4.5 font-medium text-fg-muted">
          {label}
        </span>
        {help ? <HelpTip label={`About ${label}`}>{help}</HelpTip> : null}
      </span>
      {children(labelId)}
    </div>
  );
}

/** The ⋯ button and its menu. `quiet` sits in a group header; the default in a page header. */
export function MoreMenu({
  label,
  quiet = false,
  children,
}: {
  label: string;
  quiet?: boolean;
  children: ReactNode;
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant={quiet ? "ghost" : "outline"}
          size="icon-sm"
          aria-label={label}
          className={cn(
            "rounded-[10px] pointer-coarse:size-11",
            quiet ? "-mr-1.5 text-fg-subtle hover:text-fg" : "text-fg-muted hover:text-fg",
          )}
        >
          <MoreHorizontalIcon />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-48">
        {children}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** An outlined small button, 44px on coarse pointers, the shape every row action uses. */
export function RowButton({ children, className, ...props }: ComponentProps<typeof Button>) {
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn("rounded-[10px] pointer-coarse:h-11", className)}
      {...props}
    >
      {children}
    </Button>
  );
}

const FLUSH_FORM_PAGE = [
  "[&>form>header]:mx-0 [&>form>header]:px-0 [&>form>header]:pt-0",
  "[&>form>[data-slot=form-body]]:mx-0 [&>form>[data-slot=form-body]]:px-0",
  "[&>form>footer>div]:mx-0 [&>form>footer>div]:px-0",
].join(" ");

/** A full-page form with a back link and a sticky Cancel + primary footer. */
export function ModelsFormPage({
  onClose,
  backLabel = "Models",
  className,
  ...props
}: Omit<FormFrameProps, "variant" | "back" | "onCancel"> & {
  onClose: () => void;
  backLabel?: string;
}) {
  return (
    <FormPage
      back={{ label: backLabel, onClick: onClose }}
      onCancel={onClose}
      // The settings content column already has its gutter: start the form
      // where a detail page starts instead of centring it again.
      className={cn(FLUSH_FORM_PAGE, className)}
      {...props}
    />
  );
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
