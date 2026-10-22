import type { ReactNode } from "react";
import { AppContext, type AppContextValue } from "@opengeni/react/app/app-context";

// SessionHeader only renders inside the session shell, which always provides
// the app context; its chat actions (copy link, pin) run through it. Fixtures
// that show the header on its own never run those, so any read of this
// context fails loudly instead of hiding a new dependency.
const shellAppContext = new Proxy({} as AppContextValue, {
  get(_target, key) {
    throw new Error(`This fixture's app context has no ${String(key)}`);
  },
});

export function SessionShellAppContext(props: { children: ReactNode }) {
  return <AppContext.Provider value={shellAppContext}>{props.children}</AppContext.Provider>;
}
