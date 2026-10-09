import { copyTextToClipboard } from "@opengeni/react/clipboard";
import { CheckIcon, CopyIcon, Loader2Icon } from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { Switch } from "@/components/ui/switch";
import { useAppContext } from "@/context";
import { userErrorText } from "@/lib/api-error";
import {
  detectConnectPlatform,
  installOneLiner,
  installOneLinerWindows,
  type ConnectPlatform,
} from "@/lib/deployment";
import { cn } from "@/lib/utils";

export type MintedConnectToken = {
  value: string;
  expiresAt: string;
  expiresInSeconds: number;
};

const PLATFORM_OPTIONS = [
  { value: "unix", label: "Mac / Linux" },
  { value: "windows", label: "Windows" },
] as const satisfies readonly { value: ConnectPlatform; label: string }[];

/**
 * Mints a single-use connect token in this browser. Only the latest request may
 * apply its result, so toggling screen control quickly never shows a stale token.
 */
function useConnectToken(workspaceId: string) {
  const { client } = useAppContext();
  // Minting is driven by explicit triggers (mount, screen-control changes, "New
  // command"); a new client identity on re-render must never mint again.
  const clientRef = useRef(client);
  clientRef.current = client;
  const [token, setToken] = useState<MintedConnectToken | null>(null);
  const [minting, setMinting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const sequence = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  const mint = useCallback(
    async (allowScreenControl: boolean): Promise<MintedConnectToken | null> => {
      const current = ++sequence.current;
      setMinting(true);
      setError(null);
      try {
        const result = await clientRef.current.mintEnrollToken(workspaceId, {
          allowScreenControl,
        });
        if (!alive.current || current !== sequence.current) return null;
        const next = {
          value: result.token,
          expiresAt: result.expiresAt,
          expiresInSeconds: result.expiresInSeconds,
        };
        setToken(next);
        return next;
      } catch (failure) {
        if (alive.current && current === sequence.current) {
          setToken(null);
          setError(userErrorText(failure, "Try again."));
        }
        return null;
      } finally {
        if (alive.current && current === sequence.current) setMinting(false);
      }
    },
    [workspaceId],
  );
  return { token, minting, error, mint };
}

/** "2:05 PM" for today, otherwise a date and time; relative when unparseable. */
export function formatConnectExpiry(expiresAt: string, expiresInSeconds: number): string {
  const at = new Date(expiresAt);
  if (Number.isNaN(at.getTime())) {
    return `about ${Math.max(1, Math.round(expiresInSeconds / 60))} min from now`;
  }
  const sameDay = at.toDateString() === new Date().toDateString();
  return sameDay
    ? at.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" });
}

/**
 * The one-command machine connect step, shared by the Machines page and the
 * in-chat Connected Machine card. It mints a single-use token on mount and again
 * when screen control changes, so the command always matches the checkbox.
 */
export function MachineConnectCommand({
  workspaceId,
  origin,
  onMinted,
  className,
}: {
  workspaceId: string;
  origin: string;
  /** Called with each freshly minted token (for example, to start watching). */
  onMinted?: ((token: MintedConnectToken) => void) | undefined;
  className?: string;
}) {
  const [platform, setPlatform] = useState<ConnectPlatform>(() =>
    detectConnectPlatform(typeof navigator === "undefined" ? undefined : navigator.userAgent),
  );
  const [allowScreenControl, setAllowScreenControl] = useState(false);
  const screenControlId = useId();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const { token, minting, error, mint } = useConnectToken(workspaceId);
  const onMintedRef = useRef(onMinted);
  onMintedRef.current = onMinted;

  const mintNow = useCallback(
    async (screenControl: boolean) => {
      setCopied(false);
      setCopyFailed(false);
      const next = await mint(screenControl);
      if (next) onMintedRef.current?.(next);
    },
    [mint],
  );

  useEffect(() => {
    void mintNow(allowScreenControl);
  }, [mintNow, allowScreenControl]);

  const command = token
    ? platform === "windows"
      ? installOneLinerWindows(origin, { enrollToken: token.value })
      : installOneLiner(origin, { enrollToken: token.value })
    : "";

  async function copy() {
    if (!command) return;
    const ok = await copyTextToClipboard(command);
    setCopied(ok);
    setCopyFailed(!ok);
  }

  return (
    <div className={cn("flex flex-col gap-3", className)} data-machine-connect-command="">
      <SegmentedControl
        aria-label="Machine type"
        size="sm"
        fullWidth
        options={PLATFORM_OPTIONS}
        value={platform}
        onValueChange={(value) => {
          setPlatform(value);
          setCopied(false);
        }}
      />
      {/* Screen control is baked into the token, so it is chosen before copying. */}
      <div className="flex items-start justify-between gap-3">
        <label htmlFor={screenControlId} className="flex flex-col gap-0.5 text-xs leading-4">
          <span className="text-fg">Allow screen control</span>
          <span className="text-2xs text-fg-muted">
            Agents can see and use this machine's screen. Leave off for terminal-only use.
          </span>
        </label>
        <Switch
          id={screenControlId}
          size="sm"
          checked={allowScreenControl}
          onCheckedChange={(checked) => setAllowScreenControl(checked)}
        />
      </div>
      <p className="text-xs leading-5 text-fg-muted">
        {platform === "windows"
          ? "Paste this into PowerShell on the computer you want to connect."
          : "Paste this into Terminal on the computer you want to connect."}{" "}
        It installs the OpenGeni agent and keeps the machine connected in the background.
      </p>
      {error ? (
        <Notice
          tone="failed"
          title="Couldn't create a connect command"
          action={
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => void mintNow(allowScreenControl)}
            >
              Try again
            </Button>
          }
        >
          {error}
        </Notice>
      ) : (
        <div className="rounded-md border border-border bg-bg p-2.5" aria-busy={minting}>
          {minting || !token ? (
            <p className="flex items-center gap-2 text-2xs text-fg-muted" role="status">
              <Loader2Icon className="size-3.5 animate-spin" aria-hidden />
              Preparing your command…
            </p>
          ) : (
            <pre
              className="max-h-28 overflow-y-auto whitespace-pre-wrap break-all font-mono text-2xs leading-4 text-fg"
              aria-label="Connect command"
            >
              {command}
            </pre>
          )}
        </div>
      )}
      <Button
        type="button"
        size="sm"
        className="w-full"
        aria-disabled={!command || minting || undefined}
        onClick={() => {
          if (command && !minting) void copy();
        }}
      >
        {copied ? <CheckIcon aria-hidden /> : <CopyIcon aria-hidden />}
        {copied ? "Copied" : "Copy command"}
      </Button>
      {copyFailed ? (
        <p role="alert" className="text-2xs text-danger">
          Couldn't copy automatically. Select the command and copy it.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-2xs text-fg-muted">
        <span>
          {token
            ? `Works for one machine until ${formatConnectExpiry(token.expiresAt, token.expiresInSeconds)}. Keep it private.`
            : "Works for one machine. Keep it private."}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => void mintNow(allowScreenControl)}
        >
          New command
        </Button>
      </div>
    </div>
  );
}
