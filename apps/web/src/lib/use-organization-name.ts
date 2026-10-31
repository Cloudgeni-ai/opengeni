import { useEffect, useState } from "react";

import { useOptionalAppContext, type AppContextValue } from "@opengeni/react/app/app-context";
import { orgName } from "@opengeni/react/app/lib/org";

/**
 * The organization's real name. Access grants usually carry none, so an
 * organization admin reads it from the organization overview; everyone else
 * gets null and the caller words the sentence without it ("your
 * organization"), never with an id.
 *
 * A component handed its app context as a prop passes it as `source`.
 */
export function useOrganizationName(
  accountId: string,
  canReadOverview: boolean,
  source?: Pick<AppContextValue, "client" | "accessContext">,
): string | null {
  const provided = useOptionalAppContext();
  const context = source ?? provided;
  if (!context) throw new Error("Opengeni app context is not ready");
  const fromGrant = accountId ? orgName(accountId, context.accessContext.accountGrants) : null;
  const [fetched, setFetched] = useState<{ accountId: string; name: string } | null>(null);
  const client = context.client;
  const wanted = Boolean(accountId) && !fromGrant && canReadOverview;
  useEffect(() => {
    if (!wanted) return;
    let live = true;
    client
      .getOrganizationAdministrationOverview(accountId)
      .then((overview) => {
        const name = overview?.organization?.name?.trim();
        if (live && name) setFetched({ accountId, name });
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [client, accountId, wanted]);
  return fromGrant ?? (fetched?.accountId === accountId ? fetched.name : null);
}
