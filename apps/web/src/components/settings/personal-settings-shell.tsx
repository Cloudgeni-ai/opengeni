import { Link, useRouterState } from "@tanstack/react-router";
import { ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { PrivacyPreferencesSection } from "./privacy-preferences";
import { SettingsShell, settingsHomeLink } from "./settings-sidebar";
import { parseReturnTo, returnToOf, returnToSearch } from "@/lib/return-to";

/**
 * Personal settings: the settings rail's Your account section. Personal
 * security works without any workspace access, so it renders before workspace
 * access loads and lists only the account's own pages. Opened from workspace or
 * organization settings, its back link returns to the page it came from.
 */
export function PersonalSettingsShell({ email, children }: { email: string; children: ReactNode }) {
  const search = useRouterState({
    select: (state) => state.location.search as Record<string, unknown>,
  });
  const returnTo = returnToOf(parseReturnTo(search));
  const back = returnTo
    ? { label: returnTo.label, link: returnLink(returnTo.path) }
    : { label: "Back to Opengeni", link: <Link to="/" /> };
  return (
    <SettingsShell
      label="Settings"
      back={back}
      home={settingsHomeLink()}
      sections={[
        {
          id: "account",
          label: "Your account",
          meta: email,
          groups: [
            {
              items: [
                {
                  id: "account:security",
                  label: "Security",
                  icon: ShieldCheckIcon,
                  link: <Link to="/settings/security" search={returnToSearch(returnTo)} />,
                },
              ],
            },
          ],
        },
      ]}
      activeId="account:security"
      currentPage="Security"
      currentScope={`Your account · ${email}`}
      // The Security page draws its own heading (it is the focus fallback after a dialog).
      page={null}
    >
      {children}
      <PrivacyPreferencesSection />
    </SettingsShell>
  );
}

/** A router link to an in-app path that carries its own search ("/workspaces/1/settings?section=models"). */
function returnLink(path: string) {
  const url = new URL(path, "https://in-app.invalid");
  return <Link to={url.pathname} search={Object.fromEntries(url.searchParams)} />;
}
