// Settings > Computer use: what Opengeni may do on the computer the desktop
// app runs on. Only inside the desktop app; elsewhere it says where to find it.
import { MonitorIcon } from "lucide-react";

import { AppShotsSettings } from "@/components/desktop/app-shots-settings";
import {
  ThisComputerAgentSettings,
  ThisComputerMicrophoneSettings,
} from "@/components/desktop/this-computer-settings";
import { thisComputerSettingsAvailable } from "@/lib/this-computer-page";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { Notice } from "@opengeni/react/ui/notice";
import { PageHeader } from "@opengeni/react/ui/page-header";

export function ComputerUseRoute() {
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<MonitorIcon className="size-4" />}
        title="Computer use"
        description="What agents may do on this computer. Changing the screen or Chrome restarts the agent here and stops what it's running."
      />
      <div className="flex flex-col gap-6 pt-6">
        {thisComputerSettingsAvailable() ? (
          <>
            <ThisComputerAgentSettings />
            <AppShotsSettings />
            <ThisComputerMicrophoneSettings />
          </>
        ) : (
          <Notice tone="muted">These settings are in the Opengeni desktop app.</Notice>
        )}
      </div>
    </ContentPage>
  );
}
