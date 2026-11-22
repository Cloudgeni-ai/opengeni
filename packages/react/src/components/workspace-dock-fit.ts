/**
 * Which optional dock tabs the strip shows by itself: as many as fit beside
 * the tabs that are always there, in the dock's order; the rest stay in the
 * "+" menu. Pure, so the dock's measuring stays a thin layer over it.
 */
export type DockTabFitInput = {
  /** Every tab id, in strip order. */
  order: readonly string[];
  /** Tabs shown whatever the room: always-on tabs and the ones the person opened or selected. */
  required: ReadonlySet<string>;
  /** Optional tabs that may fill spare room (not the ones kept in the menu). */
  fillable: ReadonlySet<string>;
  /** Each tab's natural width without a close button, in px. */
  widths: Readonly<Record<string, number>>;
  /** The room the strip may take, in px. */
  available: number;
  /** The gap between two tabs, in px. */
  gap: number;
  /** The extra width of a tab's close button, in px. */
  closeWidth: number;
};

export type DockTabFit = {
  /** Fillable tabs shown although nobody opened them. */
  filled: ReadonlySet<string>;
  /**
   * Fillable tabs that would show on their own; they carry no close button,
   * since closing one would only bring it back.
   */
  natural: ReadonlySet<string>;
};

const NONE: DockTabFit = { filled: new Set(), natural: new Set() };

function fill(
  input: DockTabFitInput,
  reserved: ReadonlySet<string>,
  closable: (id: string) => boolean,
): Set<string> {
  const width = (id: string) => (input.widths[id] ?? 0) + (closable(id) ? input.closeWidth : 0);
  let used = 0;
  let count = 0;
  for (const id of input.order) {
    if (!reserved.has(id)) continue;
    used += width(id) + (count > 0 ? input.gap : 0);
    count += 1;
  }
  const fitted = new Set<string>();
  for (const id of input.order) {
    if (reserved.has(id) || !input.fillable.has(id)) continue;
    const next = used + width(id) + (count > 0 ? input.gap : 0);
    // In order: the first tab that doesn't fit ends the strip, so tabs never
    // jump past one another as the dock is resized.
    if (next > input.available) break;
    used = next;
    count += 1;
    fitted.add(id);
  }
  return fitted;
}

export function fitDockTabs(input: DockTabFitInput): DockTabFit {
  // Unmeasured (no layout yet, or a test DOM): only the required tabs show.
  const measured = (id: string) =>
    !(input.required.has(id) || input.fillable.has(id)) || (input.widths[id] ?? 0) > 0;
  if (!(input.available > 0) || !input.order.every(measured)) return NONE;
  // What would show if the person had opened nothing: tabs there anyway
  // need no close button.
  const always = new Set(
    input.order.filter((id) => input.required.has(id) && !input.fillable.has(id)),
  );
  const natural = fill(input, always, () => false);
  // Then room for what they opened (with its close button) comes first.
  const filled = fill(
    input,
    input.required,
    (id) => input.fillable.has(id) && input.required.has(id) && !natural.has(id),
  );
  return { filled, natural };
}
