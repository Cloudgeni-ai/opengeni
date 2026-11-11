// Excel's theme and the person's selection, followed while the pane is open.
import { excel, office } from "./host";
import { readSelection, type SelectionRequestContext, type SelectionSnapshot } from "./selection";

/** Light or dark from Excel's own theme (Office 2016+ reports its body color). */
export function officeTheme(): "light" | "dark" | undefined {
  const color = office().context.officeTheme?.bodyBackgroundColor;
  const match = color ? /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/iu.exec(color) : null;
  if (!match) return undefined;
  const [r, g, b] = match.slice(1).map((part) => parseInt(part, 16) / 255) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.5 ? "dark" : "light";
}

function onDocumentEvent(event: string | undefined, handler: () => void): () => void {
  const document = office().context.document;
  if (!event || !document?.addHandlerAsync) return () => undefined;
  try {
    document.addHandlerAsync(event, handler);
  } catch {
    // Hosts without the event never call it.
    return () => undefined;
  }
  return () => {
    try {
      document.removeHandlerAsync?.(event, { handler });
    } catch {
      // Nothing registered.
    }
  };
}

/** Calls `onChange` when Excel's theme changes (Windows reports it live). Returns a stop function. */
export function watchOfficeTheme(onChange: (theme: "light" | "dark" | undefined) => void) {
  const Office = office();
  return onDocumentEvent(Office.EventType.OfficeThemeChanged ?? "officeThemeChanged", () =>
    onChange(officeTheme()),
  );
}

/**
 * Reads the selection now and shortly after each selection or sheet change,
 * one read at a time. Returns a stop function.
 */
export function watchSelection(onChange: (selection: SelectionSnapshot) => void): () => void {
  const Office = office();
  let live = true;
  let reading = false;
  let again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const schedule = () => {
    clearTimeout(timer);
    timer = setTimeout(() => void read(), 150);
  };
  const read = async () => {
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    try {
      const next = await excel().run((context) =>
        readSelection(context as SelectionRequestContext),
      );
      if (live) onChange(next);
    } catch {
      // Keep the last selection; the next change reads again.
    } finally {
      reading = false;
      if (again && live) {
        again = false;
        schedule();
      }
    }
  };
  void read();
  const stop = onDocumentEvent(
    Office.EventType.DocumentSelectionChanged ?? "documentSelectionChanged",
    schedule,
  );
  return () => {
    live = false;
    clearTimeout(timer);
    stop();
  };
}
