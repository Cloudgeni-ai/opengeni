import { Link } from "@tanstack/react-router";
import { ArrowLeftIcon, ShieldCheckIcon } from "lucide-react";
import type { ReactNode } from "react";

import { SettingsFrame } from "./settings-frame";
import { NavItem } from "@/components/ui/settings-nav";

/** Personal settings: the same frame and sub-nav as workspace and organization settings. */
export function PersonalSettingsShell({ email, children }: { email: string; children: ReactNode }) {
  return (
    <div className="flex h-full min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-bg text-fg">
      <SettingsFrame
        label="Personal settings"
        heading="Personal settings"
        subheading={email}
        header={
          <NavItem asChild label="Back to OpenGeni" icon={<ArrowLeftIcon />}>
            <Link to="/" />
          </NavItem>
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
        indexLink={<Link to="/settings/security" />}
        page={{
          title: "Security",
          description: "Manage how you sign in and protect your account.",
        }}
      >
        {children}
      </SettingsFrame>
    </div>
  );
}
