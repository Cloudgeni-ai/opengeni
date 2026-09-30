import { Button } from "@/components/ui/button";
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckIcon, UploadIcon } from "lucide-react";
import { CopyField } from "@/components/ui/copy-field";
import { Disclosure } from "@/components/ui/disclosure";
import { Field, FieldStack, TextInput, useFieldControlProps } from "@/components/ui/field";

export type ClaudeIdentity = { accountUuid: string; deviceId: string };
const accountPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const devicePattern = /^[a-f0-9]{64}$/;

/** Extract only the two required fields; never retain or submit the settings file. */
export function parseClaudeSettings(text: string): ClaudeIdentity {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Choose the .claude.json settings file from Claude Code.");
  }
  if (!value || typeof value !== "object")
    throw new Error("This file has no Claude account details.");
  const config = value as { oauthAccount?: { accountUuid?: unknown }; userID?: unknown };
  if (
    typeof config.oauthAccount?.accountUuid !== "string" ||
    !accountPattern.test(config.oauthAccount.accountUuid) ||
    typeof config.userID !== "string" ||
    !devicePattern.test(config.userID)
  ) {
    throw new Error(
      "Account details are missing. Sign in to Claude Code, then choose its .claude.json file again.",
    );
  }
  return { accountUuid: config.oauthAccount.accountUuid, deviceId: config.userID };
}

export function ClaudeTokenInstructions() {
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-fg-muted">
        In a terminal on the computer where you use Claude Code, run this command and follow the
        sign-in instructions. Copy the token it gives you.
      </p>
      <CopyField value="claude setup-token" label="Create a Claude setup token" variant="field" />
      <p className="text-xs text-fg-muted">
        Usage comes from your Claude plan. OpenGeni does not refresh setup tokens; replace yours
        here if it expires or is revoked.
      </p>
    </div>
  );
}

function ClaudeImportButton({ ready, onClick }: { ready: boolean; onClick: () => void }) {
  const fieldProps = useFieldControlProps();
  return (
    <Button
      {...fieldProps}
      type="button"
      variant="outline"
      className="w-fit"
      aria-label="Import Claude account details"
      onClick={onClick}
    >
      <UploadIcon aria-hidden="true" />
      {ready ? "Choose another settings file" : "Choose Claude settings file"}
    </Button>
  );
}

export function useClaudeIdentityFields(enabled: boolean) {
  const [accountUuid, setAccountUuid] = useState("");
  const [deviceId, setDeviceId] = useState("");
  const [error, setError] = useState<string>();
  const importGeneration = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  useEffect(
    () => () => {
      importGeneration.current += 1;
    },
    [],
  );
  const accountValid = accountPattern.test(accountUuid.trim());
  const deviceValid = devicePattern.test(deviceId.trim());
  const valid = !enabled || (accountValid && deviceValid);
  const reset = useCallback(() => {
    importGeneration.current += 1;
    setAccountUuid("");
    setDeviceId("");
    setError(undefined);
  }, []);
  return {
    valid,
    identity: enabled ? { accountUuid: accountUuid.trim(), deviceId: deviceId.trim() } : undefined,
    reset,
    fields: enabled ? (
      <FieldStack>
        <Field
          label="Claude account details"
          hint="Choose .claude.json from your home folder on the same computer. Only the two account identifiers are read; the file itself is never uploaded."
          error={error ? <span role="alert">{error}</span> : undefined}
        >
          <ClaudeImportButton ready={valid} onClick={() => fileInput.current?.click()} />
          <input
            ref={fileInput}
            hidden
            tabIndex={-1}
            aria-hidden="true"
            type="file"
            aria-label="Import Claude account details"
            accept=".json,application/json"
            onChange={async (event) => {
              const file = event.target.files?.[0];
              event.target.value = "";
              if (!file) return;
              const generation = ++importGeneration.current;
              setError(undefined);
              setAccountUuid("");
              setDeviceId("");
              try {
                if (file.size > 10 * 1024 * 1024)
                  throw new Error(
                    "Choose a settings file smaller than 10 MB, or enter the details manually.",
                  );
                const identity = parseClaudeSettings(await file.text());
                if (generation !== importGeneration.current) return;
                setAccountUuid(identity.accountUuid);
                setDeviceId(identity.deviceId);
              } catch (caught) {
                if (generation !== importGeneration.current) return;
                setError(caught instanceof Error ? caught.message : "Couldn't read this file.");
              }
            }}
          />
        </Field>
        {valid ? (
          <p role="status" className="flex items-center gap-2 text-sm text-fg-muted">
            <CheckIcon className="size-4" aria-hidden="true" />
            Account details ready
          </p>
        ) : null}
        <Disclosure title="Find the file or enter details manually" summary="Claude Code settings">
          <div className="flex flex-col gap-4 pt-3">
            <p className="text-sm text-fg-muted">
              In the file picker on macOS, press ⌘⇧G and enter ~/.claude.json. On Windows, look in
              your user folder. Use details from the same Claude account as the token.
            </p>
            <Field
              label="Account UUID"
              hint="oauthAccount.accountUuid in ~/.claude.json"
              error={accountUuid && !accountValid ? "Enter a complete account UUID." : undefined}
            >
              <TextInput
                aria-label="Claude account UUID"
                value={accountUuid}
                autoComplete="off"
                onChange={(event) => {
                  importGeneration.current += 1;
                  setAccountUuid(event.target.value);
                  setError(undefined);
                }}
              />
            </Field>
            <Field
              label="Device ID"
              hint="userID in the same ~/.claude.json file"
              error={deviceId && !deviceValid ? "Enter the 64-character device ID." : undefined}
            >
              <TextInput
                aria-label="Claude device ID"
                value={deviceId}
                autoComplete="off"
                onChange={(event) => {
                  importGeneration.current += 1;
                  setDeviceId(event.target.value);
                  setError(undefined);
                }}
              />
            </Field>
          </div>
        </Disclosure>
      </FieldStack>
    ) : null,
  };
}

export const CLAUDE_MODEL_CHOICES = [
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Claude Sonnet 5.5" },
] as const;
export function claudeModelLabel(id: string) {
  return CLAUDE_MODEL_CHOICES.find((model) => model.id === id)?.label ?? id;
}
