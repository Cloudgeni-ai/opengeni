import { Link } from "@tanstack/react-router";
import { ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ContentPage } from "@/components/ui/content-layout";
import {
  SettingsSidebar,
  SETTINGS_SHELL_CLASS,
  SETTINGS_NAV_CLASS,
  settingsNavItemClass,
} from "./settings-sidebar";

export function PersonalSettingsShell({ email, children }: { email: string; children: ReactNode }) {
  return (
    <div className={SETTINGS_SHELL_CLASS}>
      <SettingsSidebar
        label="Personal settings"
        currentPage="Security"
        identity={<p className="mt-1 break-words text-sm font-medium text-fg">{email}</p>}
      >
        <nav aria-label="Personal settings pages" className={SETTINGS_NAV_CLASS}>
          <Link to="/settings/security" className={settingsNavItemClass(true)} aria-current="page">
            <ShieldCheckIcon className="size-4" aria-hidden="true" /> Security
          </Link>
        </nav>
      </SettingsSidebar>
      <ContentPage width="standard" className="max-w-3xl py-6 lg:py-8">
        {children}
      </ContentPage>
    </div>
  );
}
