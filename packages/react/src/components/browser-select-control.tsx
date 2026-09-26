import type {
  BrowserAction,
  BrowserActionReceipt,
  BrowserObservation,
  InteractionSemanticNode,
} from "@opengeni/sdk/interaction";
import { useEffect, useRef, useState } from "react";

type NativeOption = { value: string; label: string; selected: boolean; disabled: boolean };
type NativeSelect = {
  kind: "native-select";
  multiple: boolean;
  disabled: boolean;
  options: NativeOption[];
};

function focusedSelect(
  observation: BrowserObservation,
): { node: InteractionSemanticNode; control: NativeSelect } | null {
  if (observation.semantic?.kind !== "snapshot") return null;
  const pending = [...observation.semantic.roots];
  while (pending.length) {
    const node = pending.pop()!;
    if (node.children) pending.push(...node.children);
    if (
      node.ref !== observation.focusedRef ||
      !node.actions.includes("select") ||
      node.native?.platform !== "dom"
    )
      continue;
    const data = node.native.data as Partial<NativeSelect> | null;
    if (
      !data ||
      data.kind !== "native-select" ||
      typeof data.multiple !== "boolean" ||
      typeof data.disabled !== "boolean" ||
      !Array.isArray(data.options) ||
      data.options.length > 200
    )
      return null;
    if (
      data.options.some(
        (option) =>
          !option ||
          typeof option.value !== "string" ||
          typeof option.label !== "string" ||
          typeof option.selected !== "boolean" ||
          typeof option.disabled !== "boolean",
      )
    )
      return null;
    return { node, control: data as NativeSelect };
  }
  return null;
}

/** Human fallback for native popup windows missing from Chromium page frames. */
export function BrowserSelectControl(props: {
  observe: () => Promise<BrowserObservation>;
  act: (action: BrowserAction, observation: BrowserObservation) => Promise<BrowserActionReceipt>;
}) {
  const [snapshot, setSnapshot] = useState<BrowserObservation | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [values, setValues] = useState<string[]>([]);
  const request = useRef(0);
  useEffect(
    () => () => {
      request.current += 1;
    },
    [],
  );
  const selected = snapshot ? focusedSelect(snapshot) : null;
  const ambiguousValue = (value: string): boolean =>
    (selected?.control.options.filter((option) => option.value === value || option.label === value)
      .length ?? 0) !== 1;
  const load = async () => {
    const current = ++request.current;
    setOpen(true);
    setBusy(true);
    setSnapshot(null);
    setError(null);
    try {
      const observation = await props.observe();
      if (current !== request.current) return;
      setSnapshot(observation);
      setValues(
        focusedSelect(observation)
          ?.control.options.filter((option) => option.selected)
          .map((option) => option.value) ?? [],
      );
    } catch (cause) {
      if (current === request.current)
        setError(cause instanceof Error ? cause.message : "Could not read options.");
    } finally {
      if (current === request.current) setBusy(false);
    }
  };
  const apply = async (next: string[]) => {
    if (!snapshot || !selected || busy) return;
    const current = ++request.current;
    setBusy(true);
    setError(null);
    try {
      const receipt = await props.act(
        { type: "select", locator: { kind: "ref", ref: selected.node.ref }, values: next },
        snapshot,
      );
      if (receipt.state !== "completed")
        throw new Error(receipt.error?.message ?? "Selection did not complete.");
      if (current === request.current) {
        setOpen(false);
        setSnapshot(null);
      }
    } catch (cause) {
      if (current === request.current) {
        setError(
          cause instanceof Error ? cause.message : "Selection failed. Read the options again.",
        );
        setSnapshot(null); // Never replay an uncertain action.
      }
    } finally {
      if (current === request.current) setBusy(false);
    }
  };
  return (
    <div className="absolute bottom-3 left-3 z-10 max-w-[calc(100%-1.5rem)] text-og-control">
      <button
        type="button"
        className="rounded-og-sm border border-og-border bg-og-bg px-2 py-1 text-og-fg"
        disabled={busy}
        onClick={() => void load()}
        aria-expanded={open}
      >
        Choose option
      </button>
      {open ? (
        <section
          aria-label="Page selection options"
          className="mt-1 max-h-72 w-72 max-w-full overflow-auto rounded-og-sm border border-og-border bg-og-bg p-3 text-og-fg shadow-lg"
        >
          <div className="flex items-center justify-between gap-2">
            <strong>{selected?.node.name || "Page options"}</strong>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                ++request.current;
                setOpen(false);
                setSnapshot(null);
              }}
              aria-label="Close page options"
            >
              Close
            </button>
          </div>
          {busy ? (
            <p role="status">Loading…</p>
          ) : error ? (
            <p role="alert">{error}</p>
          ) : !selected ? (
            <p>Click a dropdown in the page, then choose “Choose option”.</p>
          ) : selected.control.disabled ? (
            <p>This control is disabled.</p>
          ) : (
            <>
              {selected.control.options.map((option, index) => {
                // Existing select actions accept value OR label. Refuse collisions
                // rather than choosing an unintended duplicate or another label.
                const ambiguous = ambiguousValue(option.value);
                const disabled = busy || option.disabled || ambiguous;
                return selected.control.multiple ? (
                  <label key={index} className="my-1 flex items-center gap-2">
                    <input
                      type="checkbox"
                      disabled={disabled}
                      checked={values.includes(option.value)}
                      onChange={(event) =>
                        setValues(
                          event.target.checked
                            ? [...values, option.value]
                            : values.filter((value) => value !== option.value),
                        )
                      }
                    />
                    {option.label || "(empty)"}
                    {ambiguous ? " (ambiguous value)" : ""}
                  </label>
                ) : (
                  <button
                    key={index}
                    type="button"
                    disabled={disabled}
                    aria-pressed={option.selected}
                    className="my-1 block w-full rounded-og-sm border border-og-border px-2 py-1 text-left disabled:opacity-50"
                    onClick={() => void apply([option.value])}
                  >
                    {option.label || "(empty)"}
                    {option.selected ? " ✓" : ""}
                    {ambiguous ? " (ambiguous value)" : ""}
                  </button>
                );
              })}
              {selected.control.multiple ? (
                <button
                  type="button"
                  disabled={busy || values.some(ambiguousValue)}
                  onClick={() => void apply(values)}
                >
                  Apply selection
                </button>
              ) : null}
            </>
          )}
        </section>
      ) : null}
    </div>
  );
}
