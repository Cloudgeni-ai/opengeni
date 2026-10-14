// Stand-in for "@/context" in the usage-limit fixture: each scenario renders
// the production components under its own client, config and permissions.
import { createContext, useCallback, useContext, useRef, type ReactNode } from "react";

import type { AppContextValue } from "../src/context";

const ScenarioContext = createContext<AppContextValue | null>(null);

export function ScenarioProvider(props: { value: unknown; children: ReactNode }) {
  return (
    <ScenarioContext.Provider value={props.value as AppContextValue}>
      {props.children}
    </ScenarioContext.Provider>
  );
}

export function useOptionalAppContext(): AppContextValue | null {
  return useContext(ScenarioContext);
}

export function useAppContext(): AppContextValue {
  const value = useContext(ScenarioContext);
  if (!value) throw new Error("usage-limit fixture: scenario context missing");
  return value;
}

export function useLatestCallback<Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
): (...args: Args) => Result {
  const latest = useRef(callback);
  latest.current = callback;
  return useCallback((...args: Args) => latest.current(...args), []);
}
