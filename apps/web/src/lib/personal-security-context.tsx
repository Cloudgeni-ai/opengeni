import { createContext, useContext, type ReactNode } from "react";
import type { AuthSession, ClientConfig } from "@/types";

/** Personal authentication authority is independent of workspace membership. */
export type PersonalSecurityContextValue = {
  clientConfig: ClientConfig;
  authSession: AuthSession;
  accessKeyVersion: number;
  handleManagedSignOut: () => Promise<void>;
  revalidatePrincipalAccess: () => void;
};
const PersonalSecurityContext = createContext<PersonalSecurityContextValue | null>(null);
export function PersonalSecurityProvider({
  value,
  children,
}: {
  value: PersonalSecurityContextValue;
  children: ReactNode;
}) {
  return (
    <PersonalSecurityContext.Provider value={value}>{children}</PersonalSecurityContext.Provider>
  );
}
export function usePersonalSecurityContext() {
  return useContext(PersonalSecurityContext);
}
