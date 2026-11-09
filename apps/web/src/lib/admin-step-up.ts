import { ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE } from "@opengeni/contracts/managed-sign-in-methods";

/* ----------------------------------------------------------------------------
   Admin step-up in the console. An admin change the API refuses until the
   person confirms it's them with a passkey opens one prompt (see
   AdminStepUpDialog); once they confirm, the change is sent again. Several
   refused changes at once share the same prompt.
   -------------------------------------------------------------------------- */

export type AdminStepUpRequest = {
  /** False: the person has no passkey yet and is guided to add one. */
  passkeyRegistered: boolean;
};

type Handler = (request: AdminStepUpRequest) => Promise<boolean>;

let handler: Handler | null = null;
let pending: Promise<boolean> | null = null;

/** Mount the prompt. Returns the unmount. */
export function setAdminStepUpHandler(next: Handler): () => void {
  handler = next;
  return () => {
    if (handler === next) handler = null;
  };
}

/** The step-up a refused response asks for, or null for any other response. */
export async function adminStepUpRequested(response: Response): Promise<AdminStepUpRequest | null> {
  if (response.status !== 403) return null;
  try {
    const body = (await response.clone().json()) as {
      error?: {
        details?: { code?: unknown; passkeyRegistered?: unknown; browserRequired?: unknown };
      };
    };
    const details = body.error?.details;
    if (details?.code !== ADMIN_PASSKEY_STEP_UP_REQUIRED_CODE) return null;
    return { passkeyRegistered: details.passkeyRegistered !== false };
  } catch {
    return null;
  }
}

function resendable(input: unknown, init: RequestInit | undefined): boolean {
  if (typeof Request !== "undefined" && input instanceof Request && input.body !== null) {
    return false;
  }
  const body = init?.body;
  return !(typeof ReadableStream !== "undefined" && body instanceof ReadableStream);
}

/**
 * Send a request; when the API asks for an admin step-up, prompt once and,
 * after the person confirms, send it again. Without a prompt mounted, or when
 * they cancel, the refusal comes back as it was.
 */
export async function withAdminStepUp(
  send: () => Promise<Response>,
  request: { input: unknown; init: RequestInit | undefined },
): Promise<Response> {
  const response = await send();
  if (!handler || !resendable(request.input, request.init)) return response;
  const asked = await adminStepUpRequested(response);
  if (!asked) return response;
  const current = handler;
  pending ??= current(asked).finally(() => {
    pending = null;
  });
  return (await pending) ? await send() : response;
}
