import type { RetainedArtifactReference } from "@opengeni/sdk";
import { CheckIcon, TerminalIcon } from "lucide-react";
import { useState } from "react";
import { copyPendingTextToClipboard } from "../lib/clipboard";
import type { RetainedArtifactLoader } from "./registry";

export { isPatchFilename } from "./presented-image";

/** POSIX single-quote one argument so the URL reaches curl unchanged. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** One command that downloads this patch and applies it in the current folder. */
export function patchApplyCommand(url: string): string {
  return `curl -fsSL ${shellQuote(url)} | git apply`;
}

/** "5 minutes" from the signed URL's expiry; the default download URL lifetime otherwise. */
export function applyCommandLifetime(expiresAt: string | undefined, now = Date.now()): string {
  const expires = expiresAt ? Date.parse(expiresAt) : Number.NaN;
  const minutes = Number.isFinite(expires) ? Math.round((expires - now) / 60_000) : 5;
  if (minutes <= 1) return "1 minute";
  return `${minutes} minutes`;
}

type ApplyState =
  | { kind: "idle" }
  | { kind: "loading" }
  | { kind: "copied"; lifetime: string }
  | { kind: "manual"; command: string; lifetime: string }
  | { kind: "unavailable" }
  | { kind: "error" };

const BUTTON_CLASS =
  "inline-flex items-center gap-1.5 rounded-og-sm border border-og-border px-2.5 py-1.5 text-og-sm font-medium text-og-fg transition-colors hover:border-og-border-strong hover:bg-og-surface-2 disabled:cursor-wait disabled:opacity-60";

/**
 * "Copy command to apply these changes": mints the existing short-lived,
 * authenticated download URL for this published patch (the same authority as
 * Download) and copies `curl -fsSL '<url>' | git apply`. The URL is minted on
 * click, so the copied command works for the URL's lifetime only.
 */
export function PatchApplyCommand({
  artifact,
  filename,
  load,
}: {
  artifact: RetainedArtifactReference;
  filename: string;
  load: RetainedArtifactLoader | undefined;
}) {
  const [state, setState] = useState<ApplyState>({ kind: "idle" });

  const copy = async () => {
    if (!load) {
      setState({ kind: "unavailable" });
      return;
    }
    setState({ kind: "loading" });
    let lifetime = "5 minutes";
    // Start the URL request inside the click so the clipboard write may wait for it.
    const command = load(artifact, new AbortController().signal, { prefer: "url" }).then(
      (source) => {
        if (!source || source instanceof Uint8Array) throw new UnavailableError();
        lifetime = applyCommandLifetime(source.expiresAt);
        return patchApplyCommand(source.url);
      },
    );
    const copied = copyPendingTextToClipboard(command);
    try {
      const text = await command;
      if (await copied) setState({ kind: "copied", lifetime });
      else setState({ kind: "manual", command: text, lifetime });
    } catch (failure) {
      setState({ kind: failure instanceof UnavailableError ? "unavailable" : "error" });
    }
  };

  const label =
    state.kind === "loading"
      ? "Preparing…"
      : state.kind === "copied"
        ? "Copied"
        : state.kind === "error"
          ? "Try again"
          : "Copy command to apply these changes";

  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <div>
        <button
          type="button"
          onClick={() => void copy()}
          disabled={state.kind === "loading"}
          className={BUTTON_CLASS}
        >
          {state.kind === "copied" ? (
            <CheckIcon className="size-3.5" aria-hidden />
          ) : (
            <TerminalIcon className="size-3.5" aria-hidden />
          )}
          {label}
        </button>
      </div>
      <p className="m-0 text-og-xs leading-relaxed text-og-fg-muted" role="status">
        {state.kind === "copied"
          ? `Copied. Paste it in a terminal in your project folder and press Enter. The link in it expires in ${state.lifetime}.`
          : state.kind === "manual"
            ? `Copy this command, then run it in your project folder. The link in it expires in ${state.lifetime}.`
            : state.kind === "unavailable"
              ? `Download ${filename}, then run git apply ${filename} in your project folder.`
              : state.kind === "error"
                ? "Couldn't prepare the command. Try again, or download the file and run git apply."
                : "Runs git apply in your project folder. Works on macOS, Linux and Git Bash."}
      </p>
      {state.kind === "manual" ? (
        <input
          readOnly
          value={state.command}
          aria-label="Command to apply these changes"
          onFocus={(event) => event.currentTarget.select()}
          className="w-full min-w-0 rounded-og-sm border border-og-border bg-og-surface-2 px-2 py-1.5 font-mono text-og-xs text-og-fg"
        />
      ) : null}
    </div>
  );
}

class UnavailableError extends Error {
  constructor() {
    super("A download URL is unavailable here");
    this.name = "UnavailableError";
  }
}
