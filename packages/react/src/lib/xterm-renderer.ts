/* ----------------------------------------------------------------------------
   xterm renderer selection ladder: WebGL → 2D canvas → DOM.

   WebGL is the fast path (GPU-composited cells — the whole point of the burst
   responsiveness win). But a WebGL context can fail to init (headless / no GPU /
   blocklisted driver) or be LOST at runtime (GPU reset, tab backgrounded). On
   either, we dispose the addon and step down one tier so the terminal keeps
   painting via the 2D canvas addon, and failing that xterm's built-in DOM
   renderer (no addon).

   `attachRenderer` is pure over its `loaders` (each closes over the xterm
   instance and constructs+loads its addon, throwing on failure), so the ladder
   + context-loss downgrade unit-test without a real WebGL context.
   -------------------------------------------------------------------------- */

export type RendererTier = "webgl" | "canvas" | "dom";

export type RendererAddon = { dispose: () => void };

/** A loader constructs + `loadAddon`s its renderer, wiring `onLoss` to the
 *  addon's context-loss event, and throws if the renderer can't initialize. */
export type RendererLoaders = {
  webgl?: ((onLoss: () => void) => Promise<RendererAddon>) | undefined;
  canvas?: (() => Promise<RendererAddon>) | undefined;
};

const ORDER: RendererTier[] = ["webgl", "canvas", "dom"];

/** The next lower renderer tier, or null at the bottom (DOM). Pure. */
export function nextRendererTier(tier: RendererTier): RendererTier | null {
  const i = ORDER.indexOf(tier);
  return i >= 0 && i < ORDER.length - 1 ? ORDER[i + 1]! : null;
}

/**
 * Attach the highest renderer tier at or below `prefer` that initializes,
 * reporting the settled tier via `onTier`. On a WebGL/canvas context loss the
 * loader's `onLoss` re-enters at the next tier down, so `onTier` is called again
 * with the downgraded tier. Returns the tier chosen on this pass.
 */
export async function attachRenderer(
  prefer: RendererTier,
  loaders: RendererLoaders,
  onTier: (tier: RendererTier) => void,
): Promise<RendererTier> {
  const start = Math.max(0, ORDER.indexOf(prefer));
  for (let i = start; i < ORDER.length; i++) {
    const tier = ORDER[i]!;
    if (tier === "dom") break;
    const loader = tier === "webgl" ? loaders.webgl : loaders.canvas;
    if (!loader) continue;
    try {
      const downgrade = nextRendererTier(tier) ?? "dom";
      await loader(() => {
        void attachRenderer(downgrade, loaders, onTier);
      });
      onTier(tier);
      return tier;
    } catch {
      // Initialization failed — fall through to the next tier down.
    }
  }
  onTier("dom");
  return "dom";
}
