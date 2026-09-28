import { forwardRef, useState, type ComponentProps, type ReactNode, type Ref } from "react";
import { variableSetVariableNameReservation } from "@opengeni/contracts";
import { CircleAlertIcon, EyeIcon, EyeOffIcon, LockIcon } from "lucide-react";

import { Button } from "@/components/ui/button";
import { CopyField } from "@/components/ui/copy-field";
import { TextArea, TextInput, useFieldControlProps } from "@/components/ui/field";
import { Notice } from "@/components/ui/notice";
import { cn } from "@/lib/utils";

/* ----------------------------------------------------------------------------
   Secret values (brief 7.17): handle secrets without showing them.

   - SecretInput:  a password input, or a multi-line field for PEM and JSON
                   values, with a show-while-typing toggle.
   - SecretValue:  how a saved value reads in a list. Secrets are write-only:
                   "Secret", never dots or a preview. A plain value (once
                   variables carry a Secret flag) shows inline, and a secret
                   revealed through an audited read shows until it is hidden.
   - SecretOnce:   a token shown once inside the create flow, with Copy.
   - Variable names and .env paste: normalizeVariableName,
                   variableNameIssue, parseEnvText and EnvPastePreview.
   -------------------------------------------------------------------------- */

const NO_AUTOFILL = {
  autoComplete: "off",
  autoCorrect: "off",
  autoCapitalize: "off",
  spellCheck: false,
  "data-1p-ignore": true,
  "data-lpignore": "true",
} as const;

export const SecretInput = forwardRef<
  HTMLInputElement | HTMLTextAreaElement,
  Omit<ComponentProps<"input">, "type"> & {
    /** A multi-line field for certificates, JSON keys and connection strings. */
    multiline?: boolean;
    rows?: number;
    /** Show the eye toggle. Default true. */
    revealable?: boolean;
    /** Start visible (for example while pasting from a password manager). */
    defaultRevealed?: boolean;
  }
>(function SecretInput(
  { multiline = false, rows = 3, revealable = true, defaultRevealed = false, className, ...props },
  ref,
) {
  const [revealed, setRevealed] = useState(defaultRevealed);
  const fieldProps = useFieldControlProps();
  const controlId = props.id ?? fieldProps.id;
  const hidden = !revealed;

  const toggle = revealable ? (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      aria-label={revealed ? "Hide value" : "Show value"}
      aria-pressed={revealed}
      aria-controls={controlId}
      disabled={props.disabled ?? fieldProps.disabled}
      onClick={() => setRevealed((value) => !value)}
      className={cn(
        "absolute right-1 text-fg-subtle hover:text-fg pointer-coarse:size-11",
        multiline ? "top-1" : "top-1/2 -translate-y-1/2",
        "pointer-coarse:right-0",
      )}
    >
      {revealed ? (
        <EyeOffIcon aria-hidden="true" className="size-4" />
      ) : (
        <EyeIcon aria-hidden="true" className="size-4" />
      )}
    </Button>
  ) : null;

  return (
    <div data-slot="secret-input" className={cn("relative min-w-0", className)}>
      {multiline ? (
        <TextArea
          ref={ref as Ref<HTMLTextAreaElement>}
          mono
          rows={rows}
          {...NO_AUTOFILL}
          {...(props as ComponentProps<"textarea">)}
          data-secret-hidden={hidden || undefined}
          className={cn(revealable && "pr-11", hidden && "[-webkit-text-security:disc]")}
        />
      ) : (
        <TextInput
          ref={ref as Ref<HTMLInputElement>}
          mono
          {...NO_AUTOFILL}
          {...props}
          type={hidden ? "password" : "text"}
          className={cn(revealable && "pr-11 pointer-coarse:pr-12")}
        />
      )}
      {toggle}
    </div>
  );
});

/* ----------------------------------------------------------------------------
   SecretValue: the value cell of a saved variable.
   -------------------------------------------------------------------------- */

export function SecretValue({
  kind,
  value,
  revealed,
  revealNote,
  onHide,
  name,
  className,
}: {
  /** "secret" is write-only; "plain" shows its value (needs the Secret flag). */
  kind: "secret" | "plain";
  /** The plain value. Never pass a secret here. */
  value?: string;
  /** A secret read through the audited reveal, shown until hidden. */
  revealed?: string;
  /** Under a revealed value, for example "Logged · hides in 30s". */
  revealNote?: ReactNode;
  onHide?: () => void;
  /** The variable name, for accessible button labels. */
  name?: string;
  className?: string;
}) {
  if (kind === "plain" && value !== undefined) {
    return (
      <span data-slot="secret-value" data-kind="plain" className={cn("min-w-0", className)}>
        <CopyField value={value} label={name ? `${name} value` : "value"} className="max-w-full" />
      </span>
    );
  }
  if (revealed !== undefined) {
    return (
      <span
        data-slot="secret-value"
        data-kind="revealed"
        className={cn("flex min-w-0 flex-col gap-0.5", className)}
      >
        <span className="flex min-w-0 items-center gap-1">
          <span className="min-w-0 truncate font-mono text-xs text-fg">{revealed}</span>
          {onHide ? (
            <Button
              type="button"
              variant="ghost"
              size="xs"
              onClick={onHide}
              aria-label={name ? `Hide ${name}` : "Hide value"}
              className="shrink-0 text-fg-muted hover:text-fg pointer-coarse:h-11"
            >
              <EyeOffIcon aria-hidden="true" className="size-3.5" />
              Hide
            </Button>
          ) : null}
        </span>
        {revealNote ? (
          <span className="text-2xs font-medium text-status-running">{revealNote}</span>
        ) : null}
      </span>
    );
  }
  return (
    // Baseline-aligned with the icon centred, so "Secret" lines up with the
    // text around it in table cells and meta lines.
    <span
      data-slot="secret-value"
      data-kind="secret"
      className={cn("inline-flex min-w-0 items-baseline gap-1.5 text-xs text-fg-muted", className)}
    >
      <LockIcon aria-hidden="true" className="size-3.5 shrink-0 self-center text-fg-subtle" />
      <span>Secret</span>
    </span>
  );
}

/* ----------------------------------------------------------------------------
   SecretOnce: a new token, shown once, inside the create flow.
   -------------------------------------------------------------------------- */

export function SecretOnce({
  value,
  label = "API key",
  details,
  onCopied,
  copy,
  className,
}: {
  /** The full token. It is never shown again after this step closes. */
  value: string;
  /** What the token is, sentence case: "API key". */
  label?: string;
  /** Quiet facts under the token: name, access, expiry. */
  details?: ReactNode;
  onCopied?: () => void;
  copy?: (text: string) => Promise<boolean>;
  className?: string;
}) {
  return (
    <div data-slot="secret-once" className={cn("flex min-w-0 flex-col gap-3", className)}>
      <Notice tone="waiting">Copy this {label} now. You won't be able to see it again.</Notice>
      <CopyField
        variant="field"
        wrap
        value={value}
        label={`new ${label}`}
        onCopied={onCopied}
        copy={copy}
      />
      {details ? <div className="min-w-0 text-xs leading-4.5 text-fg-muted">{details}</div> : null}
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Variable names and .env paste.
   -------------------------------------------------------------------------- */

export const VARIABLE_NAME_MAX_LENGTH = 128;

/** What people type becomes the saved name: "pg host-name" -> "PG_HOST_NAME". */
export function normalizeVariableName(input: string): string {
  return input
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

export type VariableNameIssueKind = "invalid" | "reserved" | "duplicate";

const REPOSITORY_TOKEN_NAMES = new Set(["GITHUB_TOKEN", "GH_TOKEN", "GITLAB_TOKEN"]);

/** Why a normalized name can't be saved, in product words, or null. */
export function variableNameIssue(
  name: string,
  existingNames: Iterable<string> = [],
): { kind: VariableNameIssueKind; message: string } | null {
  if (!name) return null;
  if (name.length > VARIABLE_NAME_MAX_LENGTH) {
    return { kind: "invalid", message: `Use ${VARIABLE_NAME_MAX_LENGTH} characters or fewer.` };
  }
  if (!/^[A-Z]/.test(name)) return { kind: "invalid", message: "Start the name with a letter." };
  if (!/^[A-Z][A-Z0-9_]*$/.test(name)) {
    return { kind: "invalid", message: "Use letters, numbers and underscores only." };
  }
  const reservation = variableSetVariableNameReservation(name);
  if (reservation?.kind === "prefix") {
    return {
      kind: "reserved",
      message: `Names starting with ${reservation.value} are reserved. Use another name.`,
    };
  }
  if (reservation) {
    return {
      kind: "reserved",
      message: REPOSITORY_TOKEN_NAMES.has(name)
        ? `OpenGeni sets ${name} for repository access. Use another name, like ${name.replace(/_TOKEN$/, "")}_BOT_TOKEN.`
        : `${name} is set by the sandbox. Use another name.`,
    };
  }
  for (const existing of existingNames) {
    if (existing === name) {
      return {
        kind: "duplicate",
        message: `${name} is already in this set. Use Replace value to change it.`,
      };
    }
  }
  return null;
}

export type EnvRowStatus = "new" | "replace" | "reserved" | "invalid" | "repeated";

export interface EnvRow {
  /** 1-based line in the pasted text. */
  line: number;
  name: string;
  value: string;
  status: EnvRowStatus;
  /** Why the row is flagged. Absent for new rows. */
  message?: string;
}

const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/s;
const SINGLE_QUOTED = /^'([^']*)'\s*(?:#.*)?$/s;

function unquote(raw: string): string {
  const value = raw.trim();
  const double = DOUBLE_QUOTED.exec(value);
  if (double) {
    return double[1]!.replace(/\\(.)/g, (_, character: string) =>
      character === "n" ? "\n" : character === "r" ? "\r" : character === "t" ? "\t" : character,
    );
  }
  const single = SINGLE_QUOTED.exec(value);
  if (single) return single[1]!;
  const comment = value.search(/\s#/);
  return (comment === -1 ? value : value.slice(0, comment)).trim();
}

/**
 * Parses pasted .env text into rows. Handles comments, blank lines, `export`,
 * single and double quotes (including multi-line double-quoted values) and
 * inline comments after unquoted values. Names are normalized as typed ones
 * are. A name that appears twice keeps the last value and flags the earlier
 * line; reserved names and names already in the set are flagged too.
 */
export function parseEnvText(text: string, existingNames: Iterable<string> = []): EnvRow[] {
  const existing = new Set(existingNames);
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const rows: EnvRow[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const raw = lines[index]!.trim();
    if (!raw || raw.startsWith("#")) continue;
    const body = raw.replace(/^export\s+/, "");
    const equals = body.indexOf("=");
    if (equals <= 0) {
      rows.push({
        line: lineNumber,
        name: body.slice(0, 40),
        value: "",
        status: "invalid",
        message: `Line ${lineNumber} isn't NAME=value.`,
      });
      continue;
    }
    const typedName = body.slice(0, equals).trim();
    let rawValue = body.slice(equals + 1).trim();
    // A double-quoted value (a certificate, a JSON key) may continue over several lines.
    if (rawValue.startsWith('"') && !DOUBLE_QUOTED.test(rawValue)) {
      let end = index;
      let joined = rawValue;
      while (end + 1 < lines.length && !DOUBLE_QUOTED.test(joined)) {
        end += 1;
        joined += `\n${lines[end]}`;
      }
      if (DOUBLE_QUOTED.test(joined)) {
        rawValue = joined;
        index = end;
      }
    }
    const name = normalizeVariableName(typedName);
    const value = unquote(rawValue);
    const issue = variableNameIssue(name);
    if (issue) {
      rows.push({
        line: lineNumber,
        name: name || typedName,
        value,
        status: issue.kind === "reserved" ? "reserved" : "invalid",
        message: issue.message,
      });
      continue;
    }
    rows.push({
      line: lineNumber,
      name,
      value,
      status: existing.has(name) ? "replace" : "new",
      message: existing.has(name) ? "Already in this set. Adding replaces its value." : undefined,
    });
  }

  // Later lines win: flag earlier copies of the same name.
  const lastIndex = new Map<string, number>();
  rows.forEach((row, position) => {
    if (row.status === "new" || row.status === "replace") lastIndex.set(row.name, position);
  });
  return rows.map((row, position) =>
    (row.status === "new" || row.status === "replace") && lastIndex.get(row.name) !== position
      ? {
          ...row,
          status: "repeated" as const,
          message: `${row.name} appears again on a later line. The later value is used.`,
        }
      : row,
  );
}

/** The rows that will be saved: new and replaced values. */
export function importableEnvRows(rows: EnvRow[]): EnvRow[] {
  return rows.filter((row) => row.status === "new" || row.status === "replace");
}

/** "2 new · 1 replaces a value · 1 skipped". */
export function summarizeEnvRows(rows: EnvRow[]): string {
  const count = (status: EnvRowStatus[]) =>
    rows.filter((row) => status.includes(row.status)).length;
  const parts: string[] = [];
  const fresh = count(["new"]);
  const replaced = count(["replace"]);
  const skipped = count(["reserved", "invalid", "repeated"]);
  if (fresh) parts.push(`${fresh} new`);
  if (replaced) parts.push(`${replaced} ${replaced === 1 ? "replaces a value" : "replace values"}`);
  if (skipped) parts.push(`${skipped} skipped`);
  return parts.join(" · ");
}

const ENV_STATUS: Record<EnvRowStatus, { label: string; tone: string; icon: boolean }> = {
  new: { label: "New", tone: "text-fg-subtle", icon: false },
  replace: { label: "Replaces value", tone: "text-fg", icon: false },
  reserved: { label: "Skipped", tone: "text-danger", icon: true },
  invalid: { label: "Skipped", tone: "text-danger", icon: true },
  repeated: { label: "Skipped", tone: "text-fg-subtle", icon: false },
};

function characterCount(value: string): string {
  const length = [...value].length;
  if (length === 0) return "Empty value";
  return `${length} ${length === 1 ? "character" : "characters"}`;
}

/** The preview under Paste .env: one hairline row per variable, problems explained inline. */
export function EnvPastePreview({ rows, className }: { rows: EnvRow[]; className?: string }) {
  if (rows.length === 0) return null;
  return (
    <div data-slot="env-paste-preview" className={cn("min-w-0", className)}>
      <p className="text-xs font-medium text-fg-muted">
        {rows.length} {rows.length === 1 ? "line" : "lines"} found
        <span className="font-normal text-fg-subtle"> · {summarizeEnvRows(rows)}</span>
      </p>
      <ul className="mt-2 flex min-w-0 flex-col divide-y divide-border border-y border-border">
        {rows.map((row) => {
          const status = ENV_STATUS[row.status];
          const flagged = row.status !== "new";
          return (
            <li
              key={`${row.line}-${row.name}`}
              data-status={row.status}
              className="flex min-w-0 items-start gap-3 py-2.5"
            >
              <div className="min-w-0 flex-1">
                <p
                  className={cn(
                    "truncate font-mono text-xs leading-5",
                    row.status === "new" || row.status === "replace"
                      ? "text-fg"
                      : "text-fg-muted line-through decoration-fg-subtle/60",
                  )}
                >
                  {row.name}
                </p>
                {flagged && row.message ? (
                  <p className="mt-0.5 flex items-start gap-1 text-xs leading-4.5 text-fg-muted">
                    {status.icon ? (
                      <CircleAlertIcon
                        aria-hidden="true"
                        className="mt-0.5 size-3.5 shrink-0 text-danger"
                      />
                    ) : null}
                    <span className="min-w-0">{row.message}</span>
                  </p>
                ) : null}
              </div>
              <div className="flex shrink-0 flex-col items-end gap-0.5 pt-0.5 text-right">
                <span className={cn("text-2xs font-medium", status.tone)}>{status.label}</span>
                {row.status === "new" || row.status === "replace" ? (
                  <span className="text-2xs text-fg-subtle">{characterCount(row.value)}</span>
                ) : null}
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
