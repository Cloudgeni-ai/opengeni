/* ----------------------------------------------------------------------------
   Streaming tip ink (age-window fade)

   Append-only markdown grows at the tip. Rather than staggering per-word
   onsets (glitter under fast models), each append batch is born at wall time
   and fades in over a fixed age window:

     opacity progress = clamp((now − birth) / INK_FADE_MS, 0, 1)

   Fast arrival → many recent characters still young → a large soft band.
   Slow arrival → only the tip is young → a tight tip wash.
   Same rule both ways; time does the work. No per-word stagger, no artificial
   content lag — layout always holds the truthful text; paint only.

   Identity is the character offset into the source. CSS animation-delay =
   birth − now (often negative) so mid-fade re-renders resume, never restart.
   Runs settle back to plain text once age ≥ INK_FADE_MS (zero span cost).
   -------------------------------------------------------------------------- */

/** Keep in sync with `--og-duration-stream` / `.og-stream-ink` in styles. */
export const INK_FADE_MS = 720;
/** @deprecated Use {@link INK_FADE_MS}. */
export const WORD_ANIMATION_MS = INK_FADE_MS;

/**
 * A first observation larger than this is pre-existing history (timeline
 * opened mid-stream), not live tip — it renders instantly.
 */
const INITIAL_ANIMATED_LIMIT = 400;

type InkBatch = {
  start: number;
  end: number;
  birth: number;
};

export type StreamReveal = {
  /** Register the full current source text; new suffix becomes an ink batch. */
  observe(text: string, now: number): void;
  /**
   * CSS animation-delay (ms) for the run covering `offset`, or null when that
   * ink has settled and should render as plain text. Negative = resume mid-fade.
   */
  delayFor(offset: number, now: number): number | null;
  /** True while any batch is still inside its fade window. */
  hasActive(now: number): boolean;
};

export function createStreamReveal(): StreamReveal {
  let batches: InkBatch[] = [];
  let revealedChars = -1;

  return {
    observe(text, now) {
      if (revealedChars === -1) {
        revealedChars = text.length > INITIAL_ANIMATED_LIMIT ? text.length : 0;
      }
      if (text.length <= revealedChars) {
        // Idempotent re-observation (StrictMode) or defensive no-op on shrink.
        revealedChars = Math.max(revealedChars, text.length);
        return;
      }
      batches.push({ start: revealedChars, end: text.length, birth: now });
      revealedChars = text.length;
      batches = batches.filter((batch) => batch.birth + INK_FADE_MS > now);
    },

    delayFor(offset, now) {
      const batch = findBatch(batches, offset);
      if (!batch) {
        return null;
      }
      const delay = batch.birth - now;
      return delay + INK_FADE_MS <= 0 ? null : delay;
    },

    hasActive(now) {
      const last = batches[batches.length - 1];
      return last !== undefined && last.birth + INK_FADE_MS > now;
    },
  };
}

function findBatch(batches: readonly InkBatch[], offset: number): InkBatch | null {
  let low = 0;
  let high = batches.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    const batch = batches[mid]!;
    if (offset < batch.start) {
      high = mid - 1;
    } else if (offset >= batch.end) {
      low = mid + 1;
    } else {
      return batch;
    }
  }
  return null;
}

/* ----------------------------------------------------------------------------
   rehype: wrap still-fading source runs in `.og-stream-ink` spans.

   Contiguous offsets that share one birth (one append batch) become ONE span —
   a continuous ink surface, not per-word glitter. Code/pre stay plain. Nodes
   without source positions (syntax rewritten around them) render plain too.
   -------------------------------------------------------------------------- */

type HastText = {
  type: "text";
  value: string;
  position?: { start?: { offset?: number | undefined } | undefined } | undefined;
};

type HastParent = {
  type: string;
  tagName?: string;
  value?: string;
  children?: HastChild[];
};

type HastChild = (HastText | HastParent) & Record<string, unknown>;

export function rehypeStreamReveal(options: { reveal: StreamReveal; now: number }) {
  const { reveal, now } = options;
  return (tree: HastParent) => {
    walk(tree, false);
  };

  function walk(node: HastParent, insideVerbatim: boolean): void {
    if (!node.children) {
      return;
    }
    const verbatim = insideVerbatim || node.tagName === "code" || node.tagName === "pre";
    const next: HastChild[] = [];
    for (const child of node.children) {
      if (child.type === "text" && !verbatim) {
        next.push(...splitTextNode(child as HastText));
        continue;
      }
      walk(child as HastParent, verbatim);
      next.push(child);
    }
    node.children = next;
  }

  function splitTextNode(node: HastText): HastChild[] {
    const sourceOffset = node.position?.start?.offset;
    if (sourceOffset === undefined) {
      return [node as HastChild];
    }
    const value = node.value;
    const out: HastChild[] = [];
    let plain = "";
    const flushPlain = () => {
      if (plain.length > 0) {
        out.push({ type: "text", value: plain } as HastChild);
        plain = "";
      }
    };

    let i = 0;
    while (i < value.length) {
      const delay = reveal.delayFor(sourceOffset + i, now);
      let j = i + 1;
      while (j < value.length) {
        const nextDelay = reveal.delayFor(sourceOffset + j, now);
        if (nextDelay !== delay) {
          break;
        }
        j += 1;
      }
      const slice = value.slice(i, j);
      if (delay === null) {
        plain += slice;
      } else {
        flushPlain();
        out.push({
          type: "element",
          tagName: "span",
          properties: {
            className: ["og-stream-ink"],
            style: `animation-delay:${Math.round(delay)}ms`,
          },
          children: [{ type: "text", value: slice }],
        } as unknown as HastChild);
      }
      i = j;
    }
    flushPlain();
    return out.length > 0 ? out : [node as HastChild];
  }
}
