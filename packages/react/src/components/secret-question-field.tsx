import type {
  GeneratePasswordSpec,
  HumanInputQuestion,
  HumanInputSecretSaveTo,
  HumanInputSecretSpec,
} from "@opengeni/sdk";
import { EyeIcon, EyeOffIcon, TriangleAlertIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  resolveSecretSaveTo,
  secretAutocomplete,
  secretCanGenerate,
  secretConcealed,
  secretFieldLabel,
  secretInputMode,
  secretPatternMismatch,
  secretVaultForTarget,
  type HumanInputFormMessages,
  type SecretFieldReading,
} from "../human-input-model";
import { cn } from "../lib/cn";
import { useSecretsUi } from "../secrets-ui";

/** Read and clear one secret field at submit time; the value never enters React state. */
export type SecretFieldHandle = {
  read: () => SecretFieldReading;
  clear: () => void;
  focus: () => void;
};

const INPUT_CLASS =
  "h-10 w-full min-w-0 rounded-og-md border border-og-border bg-og-surface-1 px-3 text-og-sm text-og-fg outline-hidden placeholder:text-og-fg-subtle focus:border-og-accent disabled:opacity-50 pointer-coarse:h-11";

export type SecretQuestionFieldProps = {
  question: HumanInputQuestion & { secret: HumanInputSecretSpec };
  fieldId: string;
  messages: HumanInputFormMessages;
  autoFocus: boolean;
  /** Save to targets this person may write. Defaults to all three. */
  allowedSaveTo?: readonly HumanInputSecretSaveTo[] | undefined;
  error?: string | undefined;
  /** Question prompt chrome rendered by the form (multi-question cards). */
  describedBy?: string | undefined;
  register: (handle: SecretFieldHandle | null) => void;
  /** The person changed the field: clears a stale validation error. */
  onEdited: () => void;
};

/**
 * The ask card's secret field: an uncontrolled password input (read through a
 * ref, so the value never reaches React state, props, logs or storage) with
 * show/hide, optional Generate, an optional username placed first so password
 * managers pair the two, soft `looksLike`/`pattern` hints, and Save to.
 */
export function SecretQuestionField({
  question,
  fieldId,
  messages,
  autoFocus,
  allowedSaveTo,
  error,
  describedBy,
  register,
  onEdited,
}: SecretQuestionFieldProps) {
  const spec = question.secret;
  const ui = useSecretsUi();
  const inputRef = useRef<HTMLInputElement | null>(null);
  const usernameRef = useRef<HTMLInputElement | null>(null);
  const saveToChoice = resolveSecretSaveTo(spec, allowedSaveTo);
  const [saveTo, setSaveTo] = useState<HumanInputSecretSaveTo>(saveToChoice.initial);
  const saveToRef = useRef(saveTo);
  saveToRef.current = saveTo;
  const [revealed, setRevealed] = useState(false);
  /** No client generator: the server generates, nothing is typed. */
  const [serverGenerate, setServerGenerate] = useState<GeneratePasswordSpec | null>(null);
  const serverGenerateRef = useRef(serverGenerate);
  serverGenerateRef.current = serverGenerate;
  const [patternMismatch, setPatternMismatch] = useState(false);
  const [touched, setTouched] = useState(false);

  const concealed = secretConcealed(spec);
  const canGenerate = secretCanGenerate(spec);
  const autoComplete = secretAutocomplete(spec);
  const inputMode = secretInputMode(spec);
  const label = secretFieldLabel(spec);
  const inputId = `${fieldId}-secret`;
  const usernameId = `${fieldId}-username`;
  const saveToId = `${fieldId}-save-to`;
  const hintId = `${fieldId}-looks-like`;
  const warningId = `${fieldId}-pattern`;
  const errorId = `${fieldId}-error`;
  const vaultHintId = `${fieldId}-vault`;
  const downgradeId = `${fieldId}-downgrade`;
  const vault = secretVaultForTarget(spec, saveTo);
  const showWarning = patternMismatch && touched && !serverGenerate;

  // A callback ref clears an input as it leaves the DOM (unmount, or the
  // server-generate swap), so the browser never keeps a detached value.
  const attachInput = useCallback((node: HTMLInputElement | null) => {
    if (!node && inputRef.current) inputRef.current.value = "";
    inputRef.current = node;
  }, []);

  const checkPattern = useCallback(() => {
    setPatternMismatch(secretPatternMismatch(spec.pattern, inputRef.current?.value ?? ""));
  }, [spec.pattern]);

  useEffect(() => {
    register({
      read: () => ({
        value: serverGenerateRef.current ? null : inputRef.current?.value || null,
        generate: serverGenerateRef.current,
        username: usernameRef.current?.value ?? null,
        saveTo: saveToRef.current,
      }),
      clear: () => {
        if (inputRef.current) inputRef.current.value = "";
        setRevealed(false);
        setPatternMismatch(false);
      },
      focus: () => (inputRef.current ?? usernameRef.current)?.focus({ preventScroll: true }),
    });
    return () => register(null);
  }, [register]);

  const generate = () => {
    onEdited();
    if (ui) {
      const input = inputRef.current;
      if (!input) return;
      try {
        input.value = ui.generatePassword(spec.generate);
        setRevealed(true);
        setTouched(true);
        checkPattern();
        return;
      } catch {
        // A spec the client generator rejects: let the server generate it.
      }
    }
    setServerGenerate(spec.generate ?? {});
    setRevealed(false);
  };

  const undoServerGenerate = () => {
    onEdited();
    setServerGenerate(null);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const inputDescribedBy =
    [
      describedBy,
      spec.looksLike ? hintId : null,
      showWarning ? warningId : null,
      error ? errorId : null,
    ]
      .filter(Boolean)
      .join(" ") || undefined;
  const focusUsername = autoFocus && Boolean(spec.username) && !spec.username?.value;

  return (
    <div className="flex min-w-0 flex-col gap-3" data-secret-question={question.id}>
      {spec.username ? (
        <div className="flex min-w-0 flex-col gap-1.5">
          <label htmlFor={usernameId} className="text-og-sm font-medium text-og-fg">
            {spec.username.prompt}
          </label>
          <input
            ref={usernameRef}
            id={usernameId}
            name="username"
            type="text"
            autoComplete="username"
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            defaultValue={spec.username.value ?? ""}
            autoFocus={focusUsername}
            className={INPUT_CLASS}
          />
        </div>
      ) : null}

      <div className="flex min-w-0 flex-col gap-1.5">
        <label
          htmlFor={serverGenerate ? undefined : inputId}
          className="text-og-sm font-medium text-og-fg"
        >
          {label}
        </label>
        {serverGenerate ? (
          <div
            className="flex min-h-10 items-center gap-2 rounded-og-md border border-dashed border-og-border px-3 text-og-sm text-og-fg pointer-coarse:min-h-11"
            data-secret-server-generate=""
          >
            <span role="status" className="min-w-0 flex-1">
              {messages.secretWillGenerate}
            </span>
            <button
              type="button"
              onClick={undoServerGenerate}
              className="og-link inline-flex min-h-10 shrink-0 items-center text-og-sm pointer-coarse:min-h-11"
            >
              {messages.secretUndo}
            </button>
          </div>
        ) : (
          <div className="flex min-w-0 items-center gap-2">
            <div className="relative min-w-0 flex-1">
              <input
                ref={attachInput}
                id={inputId}
                name={`secret-${question.id}`}
                type={concealed && !revealed ? "password" : "text"}
                autoComplete={autoComplete}
                inputMode={inputMode}
                autoCapitalize="none"
                autoCorrect="off"
                spellCheck={false}
                autoFocus={autoFocus && !focusUsername}
                aria-invalid={Boolean(error)}
                aria-describedby={inputDescribedBy}
                aria-required={question.required || undefined}
                onInput={() => {
                  onEdited();
                  checkPattern();
                }}
                onBlur={() => {
                  setTouched(true);
                  checkPattern();
                }}
                className={cn(
                  INPUT_CLASS,
                  concealed && "pr-11 pointer-coarse:pr-12",
                  revealed && "font-og-mono",
                )}
              />
              {concealed ? (
                <button
                  type="button"
                  aria-pressed={revealed}
                  aria-label={revealed ? messages.secretHide : messages.secretShow}
                  aria-controls={inputId}
                  title={revealed ? messages.secretHide : messages.secretShow}
                  onClick={() => setRevealed((value) => !value)}
                  className="absolute inset-y-0 right-0 inline-flex w-10 items-center justify-center rounded-r-og-md text-og-fg-muted transition-colors hover:text-og-fg focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-og-accent/55 pointer-coarse:w-11"
                >
                  {revealed ? (
                    <EyeOffIcon aria-hidden="true" className="size-4" />
                  ) : (
                    <EyeIcon aria-hidden="true" className="size-4" />
                  )}
                </button>
              ) : null}
            </div>
            {canGenerate ? (
              <button
                type="button"
                onClick={generate}
                className="inline-flex h-10 shrink-0 items-center rounded-og-md border border-og-border bg-og-surface-1 px-3 text-og-sm font-medium text-og-fg transition-colors hover:bg-og-hover disabled:opacity-50 pointer-coarse:h-11"
              >
                {messages.secretGenerate}
              </button>
            ) : null}
          </div>
        )}
        {spec.looksLike && !serverGenerate ? (
          <p id={hintId} className="text-og-xs text-og-fg-muted">
            {messages.secretLooksLike(spec.looksLike)}
          </p>
        ) : null}
        {showWarning ? (
          <p id={warningId} className="flex items-start gap-1.5 text-og-xs text-og-fg">
            <TriangleAlertIcon
              aria-hidden="true"
              className="mt-px size-3.5 shrink-0 text-og-status-running"
            />
            <span>{messages.secretPatternWarning(spec.looksLike ?? null)}</span>
          </p>
        ) : null}
        {error ? (
          <p id={errorId} role="alert" className="text-og-xs text-og-status-failed">
            {error}
          </p>
        ) : null}
      </div>

      <div className="flex min-w-0 flex-col gap-1">
        <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1.5">
          <label htmlFor={saveToId} className="text-og-sm font-medium text-og-fg">
            {messages.secretSaveTo}
          </label>
          <select
            id={saveToId}
            value={saveTo}
            onChange={(event) => setSaveTo(event.target.value as HumanInputSecretSaveTo)}
            aria-describedby={
              [vaultHintId, saveToChoice.downgraded ? downgradeId : null]
                .filter(Boolean)
                .join(" ") || undefined
            }
            className="h-10 min-w-[10rem] cursor-pointer rounded-og-md border border-og-border bg-og-surface-1 px-2.5 text-og-sm text-og-fg outline-hidden focus:border-og-accent disabled:opacity-50 pointer-coarse:h-11"
          >
            {saveToChoice.options.map((option) => (
              <option key={option} value={option}>
                {messages.secretSaveToOptions[option]}
              </option>
            ))}
          </select>
          <span id={vaultHintId} className="min-w-0 text-og-xs text-og-fg-muted">
            {messages.secretVaultHint(saveTo, vault)}
          </span>
        </div>
        {saveToChoice.downgraded ? (
          <p id={downgradeId} className="text-og-xs text-og-fg-muted">
            {messages.secretSaveToDowngraded(saveToChoice.requested, saveToChoice.initial)}
          </p>
        ) : null}
      </div>
    </div>
  );
}
