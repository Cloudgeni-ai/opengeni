import { Link } from "@tanstack/react-router";
import { ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SettingsShell, settingsHomeLink } from "./settings-sidebar";

/** Personal settings: the same settings rail as workspace and organization settings. */
export function PersonalSettingsShell({ email, children }: { email: string; children: ReactNode }) {
  return (
    <SettingsShell
      label="Personal settings"
      back={{ label: "Back to OpenGeni", link: <Link to="/" /> }}
      home={settingsHomeLink()}
      scope={
        <div className="min-w-0 px-2.5">
          <p className="text-sm leading-5 font-semibold text-fg">Personal settings</p>
          <p className="truncate text-xs leading-4.5 text-fg-subtle">{email}</p>
        </div>
      }
      groups={[
        {
          items: [
            {
              id: "security",
              label: "Security",
              icon: ShieldCheckIcon,
              link: <Link to="/settings/security" />,
            },
          ],
        },
      ]}
      activeId="security"
      currentPage="Security"
      // The Security page draws its own heading (it is the focus fallback after a dialog).
      page={null}
    >
      {children}
    </SettingsShell>
  );
}
