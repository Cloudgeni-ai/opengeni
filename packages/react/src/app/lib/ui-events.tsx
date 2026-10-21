// Where one part of the session UI asks another to act (open find, the usage
// limit editor, chat search, focus the new-chat composer) without owning its
// state. The web app uses the page itself, as one app owns it. Each embedded
// app gets its own target, so two apps on one page never act on each other's
// requests.
import { createContext, useContext, type ReactNode } from "react";

const detached = typeof EventTarget === "undefined" ? (null as never) : new EventTarget();
const UiEventTargetContext = createContext<EventTarget | null>(null);

export function UiEventTargetProvider(props: { target: EventTarget; children?: ReactNode }) {
  return (
    <UiEventTargetContext.Provider value={props.target}>
      {props.children}
    </UiEventTargetContext.Provider>
  );
}

/** This app's request target; without a provider, the page's `window` or `document`. */
export function useUiEventTarget(page: "window" | "document"): EventTarget {
  const scoped = useContext(UiEventTargetContext);
  if (scoped) return scoped;
  if (typeof window === "undefined") return detached;
  return page === "window" ? window : document;
}
