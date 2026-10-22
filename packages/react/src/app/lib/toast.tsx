// The session UI's toasts. On a page that owns its document (the web app)
// they go to the page's one toaster, like any other sonner toast. Inside an
// embed they go only to the embed's own toaster, so the host page's sonner
// toasts and ours never show in each other's stack.
import * as Sonner from "sonner";

export const OPENGENI_TOASTER_ID = "opengeni";

// Embedded toasters in mount order. The first one shows every embed's
// toasts, so two embeds on one page share one stack instead of doubling it.
let embeddedToasters: readonly symbol[] = [];
const listeners = new Set<() => void>();

/** Held by an embed's toaster while it is mounted. */
export function retainEmbeddedToaster(owner: symbol): () => void {
  embeddedToasters = [...embeddedToasters, owner];
  listeners.forEach((listener) => listener());
  return () => {
    embeddedToasters = embeddedToasters.filter((candidate) => candidate !== owner);
    listeners.forEach((listener) => listener());
  };
}

export function subscribeEmbeddedToasters(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Whether `owner` is the embedded toaster that shows the stack. */
export function showsEmbeddedToasts(owner: symbol): boolean {
  return embeddedToasters[0] === owner;
}

type Toast = typeof Sonner.toast;
type Routed = "success" | "error" | "info" | "warning" | "loading" | "custom";

function withToaster<A extends unknown[]>(args: A): A {
  if (embeddedToasters.length === 0) return args;
  const [first, data] = args as unknown as [unknown, Sonner.ExternalToast | undefined];
  return [first, { ...data, toasterId: OPENGENI_TOASTER_ID }] as unknown as A;
}

function routed<K extends Routed>(method: K): Toast[K] {
  // Read the method at call time, so a test's mock of "sonner" applies.
  return ((...args: Parameters<Toast[K]>) =>
    (Sonner.toast[method] as (...a: unknown[]) => unknown)(...withToaster(args))) as Toast[K];
}

export const toast = Object.assign(
  (...args: Parameters<Toast>) => Sonner.toast(...withToaster(args)),
  {
    success: routed("success"),
    error: routed("error"),
    info: routed("info"),
    warning: routed("warning"),
    loading: routed("loading"),
    custom: routed("custom"),
    dismiss: (...args: Parameters<Toast["dismiss"]>) => Sonner.toast.dismiss(...args),
  },
);
