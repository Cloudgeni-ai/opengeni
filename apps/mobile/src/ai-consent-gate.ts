import { OpenGeniApiError } from "@opengeni/sdk";

/*
 * Permission to send a person's messages, files and voice to the AI providers
 * that run them. The server decides whether it is needed and holds the text
 * to show (`GET /v1/me/ai-processing-consent`); it refuses model work without
 * it. The app asks first, before a Send, a call or dictation starts, so the
 * person decides before anything leaves the phone.
 *
 * This file is the gate itself, without UI: what it knows, what it is asking,
 * and the answers. `ai-consent.tsx` draws the question.
 */

export const AI_CONSENT_REQUIRED_CODE = "ai_processing_consent_required";
export const AI_CONSENT_VERSION_MISMATCH_CODE = "ai_processing_consent_version_mismatch";

export type AiConsentDisclosure = {
  /** Opaque: names exactly this text. Granting sends it back. */
  version: string;
  title: string;
  body: string;
  providers: string[];
  privacyUrl: string | null;
};

export type AiConsentStatus = {
  required: boolean;
  disclosure: AiConsentDisclosure;
  consent: { version: string; grantedAt: string; platform: string } | null;
};

/** The server's consent routes for the signed-in person. */
export interface AiConsentApi {
  read(): Promise<AiConsentStatus>;
  grant(version: string): Promise<AiConsentStatus>;
  withdraw(): Promise<AiConsentStatus>;
}

/** The question on screen. */
export type AiConsentPrompt = {
  disclosure: AiConsentDisclosure;
  /** The text changed while it was open; this is the new text. */
  changed: boolean;
  granting: boolean;
  error: string | null;
};

export type AiConsentSnapshot = {
  /** The server's last answer; null until read. */
  status: AiConsentStatus | null;
  /** False when the deployment has no consent routes (it asks for none). */
  supported: boolean | null;
  prompt: AiConsentPrompt | null;
};

export interface AiConsentGate {
  snapshot(): AiConsentSnapshot;
  subscribe(listener: () => void): () => void;
  /**
   * Before model work starts: true when the person has allowed it, asking
   * first when needed; false when they chose not to, and nothing may be sent.
   * Joins a question already open.
   */
  ensure(): Promise<boolean>;
  /** The server refused for want of permission: ask again (see `ensure`). */
  refused(): Promise<boolean>;
  /** The open question's answer. */
  allow(): void;
  dismiss(): void;
  /** Read the state again (Settings). */
  refresh(): Promise<AiConsentStatus | null>;
  /** Grant the text Settings shows; false when it changed meanwhile (read it again). */
  grantShown(): Promise<boolean>;
  withdraw(): Promise<void>;
  /** Stop: the account changed. An open question counts as Not now. */
  close(): void;
}

function apiCode(error: unknown): string | undefined {
  if (!(error instanceof OpenGeniApiError)) return undefined;
  const code = error.details?.code;
  return typeof code === "string" ? code : undefined;
}

/** The server refused model work because the person hasn't allowed it (403). */
export function isAiConsentRequired(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    error.status === 403 &&
    apiCode(error) === AI_CONSENT_REQUIRED_CODE
  );
}

/** A grant named text that is no longer current (409). */
export function isAiConsentVersionMismatch(error: unknown): boolean {
  return (
    error instanceof OpenGeniApiError &&
    error.status === 409 &&
    apiCode(error) === AI_CONSENT_VERSION_MISMATCH_CODE
  );
}

/** A deployment from before consent: nothing to ask. */
function unsupported(error: unknown): boolean {
  return error instanceof OpenGeniApiError && (error.status === 404 || error.status === 405);
}

function message(error: unknown): string {
  if (error instanceof OpenGeniApiError && error.status >= 500)
    return "Opengeni couldn't save your choice. Try again.";
  if (error instanceof OpenGeniApiError) return error.message;
  return "Couldn't reach Opengeni. Check your connection and try again.";
}

export function createAiConsentGate(api: AiConsentApi): AiConsentGate {
  let state: AiConsentSnapshot = { status: null, supported: null, prompt: null };
  let closed = false;
  const listeners = new Set<() => void>();
  let pending: Promise<boolean> | null = null;
  let answer: ((allowed: boolean) => void) | null = null;

  const set = (patch: Partial<AiConsentSnapshot>) => {
    if (closed) return;
    state = { ...state, ...patch };
    for (const listener of [...listeners]) listener();
  };
  const settle = (allowed: boolean) => {
    const resolve = answer;
    answer = null;
    set({ prompt: null });
    resolve?.(allowed);
  };
  const allowed = (status: AiConsentStatus | null) => status !== null && !status.required;

  const ask = async (): Promise<boolean> => {
    let status: AiConsentStatus;
    try {
      // Fresh, so the question shows today's text (or none, if it was allowed elsewhere).
      status = await api.read();
    } catch (error) {
      if (unsupported(error)) {
        set({ supported: false });
        return true;
      }
      // Unknown is not a refusal: the server still refuses without permission,
      // and that refusal asks again. Nothing is remembered from this.
      return true;
    }
    set({ status, supported: true });
    if (!status.required || closed) return !closed;
    return await new Promise<boolean>((resolve) => {
      answer = resolve;
      set({
        prompt: { disclosure: status.disclosure, changed: false, granting: false, error: null },
      });
    });
  };

  const gate: AiConsentGate = {
    snapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    ensure: () => {
      if (closed) return Promise.resolve(false);
      if (pending) return pending;
      if (state.supported === false || allowed(state.status)) return Promise.resolve(true);
      const asking = ask().finally(() => {
        if (pending === asking) pending = null;
      });
      pending = asking;
      return asking;
    },
    refused: () => {
      if (pending) return pending;
      // What was known is out of date: permission was withdrawn or the text changed.
      if (state.status) set({ status: { ...state.status, required: true, consent: null } });
      set({ supported: true });
      return gate.ensure();
    },
    allow: () => {
      const prompt = state.prompt;
      if (!prompt || prompt.granting) return;
      set({ prompt: { ...prompt, granting: true, error: null } });
      void api.grant(prompt.disclosure.version).then(
        (status) => {
          set({ status });
          if (!status.required) settle(true);
          else set({ prompt: { ...prompt, granting: false } });
        },
        async (error: unknown) => {
          if (!isAiConsentVersionMismatch(error)) {
            set({ prompt: { ...prompt, granting: false, error: message(error) } });
            return;
          }
          // The text changed: show the new text. Never accept it for them.
          try {
            const status = await api.read();
            set({ status });
            if (!status.required) settle(true);
            else
              set({
                prompt: {
                  disclosure: status.disclosure,
                  changed: true,
                  granting: false,
                  error: null,
                },
              });
          } catch (readError) {
            set({ prompt: { ...prompt, granting: false, error: message(readError) } });
          }
        },
      );
    },
    dismiss: () => {
      if (state.prompt) settle(false);
    },
    refresh: async () => {
      try {
        const status = await api.read();
        set({ status, supported: true });
        return status;
      } catch (error) {
        if (unsupported(error)) set({ supported: false });
        throw error;
      }
    },
    grantShown: async () => {
      const shown = state.status;
      if (!shown) return false;
      try {
        const status = await api.grant(shown.disclosure.version);
        set({ status });
        return !status.required;
      } catch (error) {
        if (!isAiConsentVersionMismatch(error)) throw error;
        await gate.refresh();
        return false;
      }
    },
    withdraw: async () => {
      const status = await api.withdraw();
      set({ status });
    },
    close: () => {
      if (state.prompt) settle(false);
      closed = true;
      listeners.clear();
    },
  };
  return gate;
}

type ObservedResponse = { status: number; clone(): { text(): Promise<string> } };

const refusalListeners = new Set<(baseUrl: string) => void>();

/** Hear the refusals `watchAiConsentRefusals` notes for each deployment. */
export function onAiConsentRefused(listener: (baseUrl: string) => void): () => void {
  refusalListeners.add(listener);
  return () => {
    refusalListeners.delete(listener);
  };
}

/** A request to `baseUrl` was refused for want of permission. */
export function noteAiConsentRefused(baseUrl: string): void {
  for (const listener of [...refusalListeners]) listener(baseUrl);
}

/**
 * Watch a client's requests for the server's refusal for want of permission,
 * whichever request it was (a Send, an answer, a call, a recording), so the
 * question can open again. The response itself is passed on untouched.
 */
export function watchAiConsentRefusals<
  F extends (input: RequestInfo | URL, init?: RequestInit) => Promise<ObservedResponse>,
>(fetchImpl: F, onRefused: () => void): F {
  const watching = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await fetchImpl(input, init);
    if (response.status === 403) {
      void response
        .clone()
        .text()
        .then((body) => {
          const parsed = JSON.parse(body) as { error?: { details?: { code?: unknown } } };
          if (parsed.error?.details?.code === AI_CONSENT_REQUIRED_CODE) onRefused();
        })
        .catch(() => undefined);
    }
    return response;
  };
  return watching as F;
}
