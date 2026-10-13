import type { HumanInputSecretAnswerResult } from "@opengeni/sdk";
import { FileLockIcon, LockIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";
import { cn } from "../lib/cn";
import { useSecretsUi, type SecretReferenceLike, type SecretsUi } from "../secrets-ui";
import { secretReferenceLabel } from "../secret-reference-label";

export {
  secretReferenceLabel,
  secretReferenceLabelText,
  type SecretReferenceLabel,
} from "../secret-reference-label";

/* Secret references (`{{secret:GitHub/password}}`) read as small chips: a lock
   glyph and the item and field, with the exact reference on hover. Parsing
   only: a chip never resolves or shows a value. */

const CHIP_CLASS =
  // em-relative so one chip reads right in prose, payload mono runs and titles.
  "og-secret-chip inline-flex max-w-full min-w-0 items-center gap-[0.3em] rounded-full border border-og-border bg-og-surface-2 px-[0.5em] align-baseline font-og-sans text-[0.9em] leading-[1.45] font-medium not-italic text-og-fg no-underline [overflow-wrap:normal] [word-break:normal]";

function SecretChipFrame({
  icon,
  primary,
  suffix,
  title,
  srPrefix,
  href,
  className,
  dataAttributes,
}: {
  icon: "lock" | "file";
  primary: string;
  suffix: string;
  title: string;
  srPrefix: string;
  href?: string | null | undefined;
  className?: string | undefined;
  dataAttributes?: Record<string, string> | undefined;
}) {
  const Icon = icon === "file" ? FileLockIcon : LockIcon;
  const body = (
    <>
      <Icon aria-hidden="true" className="size-[1em] shrink-0 text-og-fg-muted" />
      <span className="sr-only">{srPrefix}</span>
      <span className="min-w-0 max-w-[18em] truncate">{primary}</span>
      {suffix ? <span className="shrink-0 whitespace-nowrap">{suffix}</span> : null}
    </>
  );
  if (href) {
    return (
      <a
        href={href}
        title={title}
        className={cn(
          CHIP_CLASS,
          "cursor-pointer transition-colors hover:border-og-border-strong hover:bg-og-surface-3 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-og-accent/55",
          className,
        )}
        {...dataAttributes}
      >
        {body}
      </a>
    );
  }
  return (
    <span title={title} className={cn(CHIP_CLASS, className)} {...dataAttributes}>
      {body}
    </span>
  );
}

export type SecretRefChipProps = {
  reference: SecretReferenceLike;
  /** Link to the item when the host provides `hrefForReference`. Off inside other controls. */
  linkable?: boolean | undefined;
  className?: string | undefined;
};

/** One secret reference as a chip. Focusable only when it links. */
export function SecretRefChip({ reference, linkable = true, className }: SecretRefChipProps) {
  const ui = useSecretsUi();
  return (
    <SecretRefChipView ui={ui} reference={reference} linkable={linkable} className={className} />
  );
}

function SecretRefChipView({
  ui,
  reference,
  linkable,
  className,
}: {
  ui: SecretsUi | null;
  reference: SecretReferenceLike;
  linkable: boolean;
  className?: string | undefined;
}) {
  const label = secretReferenceLabel(reference);
  const href = linkable ? (ui?.hrefForReference?.(reference) ?? null) : null;
  return (
    <SecretChipFrame
      icon={reference.kind === "secretfile" ? "file" : "lock"}
      primary={label.primary}
      suffix={label.suffix}
      title={reference.raw}
      srPrefix={reference.kind === "secretfile" ? "Secret file: " : "Secret: "}
      href={href}
      className={className}
      dataAttributes={{ "data-og-secret-ref": reference.raw }}
    />
  );
}

export type SecretRefTextProps = {
  text: string;
  linkable?: boolean | undefined;
  chipClassName?: string | undefined;
};

/**
 * Text with each valid secret reference as a chip. Malformed reference-like
 * text stays plain, and without a `SecretsUiProvider` the text is unchanged.
 */
export function SecretRefText({ text, linkable = true, chipClassName }: SecretRefTextProps) {
  const ui = useSecretsUi();
  return <>{renderSecretRefText(ui, text, { linkable, chipClassName })}</>;
}

/** Fast path: only text that mentions a reference is tokenized. */
export function mayContainSecretReference(text: string): boolean {
  return text.includes("{{secret");
}

export function renderSecretRefText(
  ui: SecretsUi | null,
  text: string,
  options: { linkable?: boolean | undefined; chipClassName?: string | undefined } = {},
): ReactNode {
  if (!ui || !mayContainSecretReference(text)) return text;
  const tokens = ui.tokenize(text);
  if (!tokens.some((token) => token.type === "reference")) return text;
  // Keys are source offsets: text runs start where the previous token ended.
  let offset = 0;
  return tokens.map((token) => {
    if (token.type === "reference") {
      offset = token.reference.end;
      return (
        <SecretRefChipView
          key={`ref-${token.reference.start}`}
          ui={ui}
          reference={token.reference}
          linkable={options.linkable ?? true}
          className={options.chipClassName}
        />
      );
    }
    if (token.type === "invalid") {
      offset = token.end;
      return <Fragment key={`invalid-${token.start}`}>{token.raw}</Fragment>;
    }
    return <Fragment key={`text-${offset}`}>{token.value}</Fragment>;
  });
}

export type SecretAnswerChipProps = {
  result: HumanInputSecretAnswerResult;
  label: string;
  className?: string | undefined;
};

/** The answered ask card: "Saved to Private › GitHub", plus the username. Never a value. */
export function SecretAnswerChip({ result, label, className }: SecretAnswerChipProps) {
  return (
    <SecretChipFrame
      icon="lock"
      primary={label}
      suffix={result.username ? ` · ${result.username}` : ""}
      title={result.reference}
      srPrefix=""
      className={cn("text-og-sm", className)}
      dataAttributes={{ "data-og-secret-answer": result.reference }}
    />
  );
}
