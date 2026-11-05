// Settings > Computer use: what Opengeni may do on the computer the desktop
// app runs on. Only inside the desktop app; elsewhere it says where to find it.
import { useNavigate, useParams } from "@tanstack/react-router";
import { MonitorIcon } from "lucide-react";

import { AppShotsSettings } from "@/components/desktop/app-shots-settings";
import {
  connectCalendarPath,
  ThisComputerAgentSettings,
  ThisComputerMicrophoneSettings,
} from "@/components/desktop/this-computer-settings";
import { thisComputerSettingsAvailable } from "@/lib/this-computer-page";
import { useAppContext } from "@opengeni/react/app/app-context";
import { DesktopDictationSettings } from "@opengeni/react/desktop-dictation";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { Notice } from "@opengeni/react/ui/notice";
import { PageHeader } from "@opengeni/react/ui/page-header";

export function ComputerUseRoute() {
  // Each dictation shortcut can pick one of the workspace's voice input models.
  const dictationModels = useAppContext().clientConfig.voiceInput?.models;
  const navigate = useNavigate();
  const { workspaceId } = useParams({ strict: false }) as { workspaceId?: string };
  return (
    <ContentPage width="standard">
      <PageHeader
        icon={<MonitorIcon className="size-4" />}
        title="Computer use"
        description="What agents may do on this computer."
      />
      <div className="flex flex-col gap-6 pt-6">
        {thisComputerSettingsAvailable() ? (
          <>
            <ThisComputerAgentSettings />
            <AppShotsSettings />
            <DesktopDictationSettings models={dictationModels} />
            <ThisComputerMicrophoneSettings
              onConnectCalendar={
                workspaceId
                  ? () => void navigate({ href: connectCalendarPath(workspaceId) })
                  : undefined
              }
            />
          </>
        ) : (
          <Notice tone="muted">These settings are in the Opengeni desktop app.</Notice>
        )}
      </div>
    </ContentPage>
  );
}
