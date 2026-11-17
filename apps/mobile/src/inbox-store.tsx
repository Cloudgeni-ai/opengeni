import { useNativeInbox } from "@opengeni/react-native/timeline";
import { createContext, useContext, type ReactNode } from "react";
import { useAccount } from "@/account";

/*
 * One inbox for the whole app: the bar's Inbox badge and the Inbox screen read
 * the same list, so answering or dismissing a row updates the count at once,
 * and only one poller runs however many screens show the bar.
 */

type AppInbox = ReturnType<typeof useNativeInbox>;

const InboxContext = createContext<AppInbox | null>(null);

export function AppInboxProvider({ children }: { children: ReactNode }) {
  const { client, status } = useAccount();
  // Only a signed-in account reads its inbox.
  const inbox = useNativeInbox(client, { enabled: status === "ready" });
  return <InboxContext.Provider value={inbox}>{children}</InboxContext.Provider>;
}

export function useAppInbox(): AppInbox {
  const inbox = useContext(InboxContext);
  if (!inbox) throw new Error("useAppInbox needs AppInboxProvider");
  return inbox;
}
