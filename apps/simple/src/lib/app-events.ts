import { createContext, useContext } from "react";

/** App-wide nudges, so a card that creates an agent can refresh the sidebar at once. */
export type AppEvents = {
  changed: () => void;
  openSettings: (tab?: string) => void;
};

export const AppEventsContext = createContext<AppEvents>({
  changed: () => {},
  openSettings: () => {},
});

export function useAppEvents() {
  return useContext(AppEventsContext);
}
