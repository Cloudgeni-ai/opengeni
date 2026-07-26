import { XIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { cn } from "../lib/cn";

/* ----------------------------------------------------------------------------
   Screenshot lightbox

   A single, app-level lightbox the computer_call / view_image renderers open by
   `src`. Built on Radix Dialog so it is focus-trapped, ESC-closable, and
   scroll-locked — fixing the v1 mockup's broken expand (an absolutely-positioned
   <img> that overflowed its row). The image is centered, constrained to the
   viewport (`max-w/max-h` + `object-contain`), and sits on a dimmed backdrop.

   Consumers render `<LightboxProvider>` once near the timeline; renderers call
   `useLightbox().open(src)`.
   -------------------------------------------------------------------------- */

type LightboxController = {
  open: (src: string, caption?: string) => void;
};

const LightboxContext = createContext<LightboxController | null>(null);

/** Open the app-level screenshot lightbox. No-op outside a `LightboxProvider`. */
export function useLightbox(): LightboxController {
  return useContext(LightboxContext) ?? NOOP;
}

/**
 * The lightbox controller when one is mounted, or `null` outside a
 * `LightboxProvider`. Lets a media primitive degrade to a non-interactive image
 * (rather than a dead "Expand" button that announces an action it cannot do).
 */
export function useLightboxOptional(): LightboxController | null {
  return useContext(LightboxContext);
}

const NOOP: LightboxController = { open: () => {} };

/**
 * The app-level screenshot lightbox. Render once near the timeline; renderers
 * call `useLightbox().open(src)`.
 *
 * Idempotent by design: when an ancestor `LightboxProvider` already exists (e.g.
 * a `MessageTimeline` mounted inside an app that already wraps its shell), this
 * one becomes a pass-through and does NOT mount a second focus-trapping Dialog.
 * That keeps `MessageTimeline` self-sufficient (it owns its own provider) while
 * composing cleanly when nested.
 */
export function LightboxProvider({ children }: { children: ReactNode }) {
  const ancestor = useContext(LightboxContext);
  if (ancestor) {
    return <>{children}</>;
  }
  return <LightboxRoot>{children}</LightboxRoot>;
}

function LightboxRoot({ children }: { children: ReactNode }) {
  const [state, setState] = useState<{ src: string; caption?: string } | null>(null);

  const open = useCallback((src: string, caption?: string) => {
    setState(caption ? { src, caption } : { src });
  }, []);

  const controller = useMemo<LightboxController>(() => ({ open }), [open]);

  return (
    <LightboxContext.Provider value={controller}>
      {children}
      <Dialog.Root open={state !== null} onOpenChange={(next) => !next && setState(null)}>
        <AnimatePresence>
          {state !== null ? (
            <Dialog.Portal forceMount>
              <Dialog.Overlay asChild forceMount>
                <motion.div
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="og-root fixed inset-0 z-50 bg-black/90 backdrop-blur-md"
                />
              </Dialog.Overlay>
              <Dialog.Content
                asChild
                forceMount
                aria-label="Screenshot"
                onOpenAutoFocus={(event) => event.preventDefault()}
              >
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.98 }}
                  transition={{ duration: 0.18, ease: [0.16, 1, 0.3, 1] }}
                  // Content is a full-inset centering wrapper layered above the
                  // Overlay, so Radix's own click-outside (which fires on the
                  // Overlay) can never see a backdrop click — every click lands on
                  // Content. We make Content's own backdrop dismiss: a click whose
                  // target is the wrapper itself (not the figure) closes it, so the
                  // figcaption's "click outside to close" affordance is real.
                  onClick={(event) => {
                    if (event.target === event.currentTarget) {
                      setState(null);
                    }
                  }}
                  className="og-root fixed inset-0 z-50 flex items-center justify-center p-6 sm:p-12"
                >
                  <Dialog.Title className="sr-only">Screenshot</Dialog.Title>
                  {/* The figure is one self-contained object: image, caption, and
                      its own close control. The close button anchors to a wrapper
                      sized to the IMAGE (w-fit), so it hugs the real top-right
                      corner regardless of aspect ratio — never floating into the
                      empty space of a wide figure column. */}
                  <figure className="m-0 flex max-h-full max-w-5xl flex-col items-center gap-3">
                    <div className="relative flex min-h-0 w-fit max-w-full">
                      {/* A plain <img>: this SDK is framework-agnostic, with no host Image component. */}
                      <img
                        src={state.src}
                        alt={state.caption ?? "Screenshot"}
                        className="min-h-0 max-h-[82vh] w-auto max-w-full rounded-og-md border border-white/10 object-contain shadow-og-lg"
                      />
                      <Dialog.Close
                        className={cn(
                          "absolute -right-3 -top-3 inline-flex size-9 items-center justify-center rounded-full",
                          "border border-white/15 bg-black/60 text-white/70 backdrop-blur",
                          "transition-colors hover:border-white/30 hover:text-white",
                        )}
                        aria-label="Close"
                      >
                        <XIcon className="size-4" />
                      </Dialog.Close>
                    </div>
                    {state.caption ? (
                      <figcaption className="max-w-2xl text-center font-og-mono text-og-xs text-white/55">
                        {state.caption}
                      </figcaption>
                    ) : (
                      <figcaption className="font-og-mono text-og-xs uppercase tracking-[0.1em] text-white/35">
                        Esc or click outside to close
                      </figcaption>
                    )}
                  </figure>
                </motion.div>
              </Dialog.Content>
            </Dialog.Portal>
          ) : null}
        </AnimatePresence>
      </Dialog.Root>
    </LightboxContext.Provider>
  );
}
