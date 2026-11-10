// Settings > Computer use: what Opengeni may do on the computer the desktop
// app runs on. Only inside the desktop app; elsewhere it says where to find it.
import { useLocation, useNavigate, useParams } from "@tanstack/react-router";
import { MonitorIcon } from "lucide-react";

import { AppShotsSettings } from "@/components/desktop/app-shots-settings";
import { useDictationHome, useDictationWorkspaces } from "@/components/desktop/dictation-workspace";
import {
  connectCalendarPath,
  ThisComputerAgentSettings,
  ThisComputerMicrophoneSettings,
} from "@/components/desktop/this-computer-settings";
import { thisComputerSettingsAvailable } from "@/lib/this-computer-page";
import { useAppContext } from "@opengeni/react/app/app-context";
import {
  DesktopDictationSettings,
  useDesktopDictation,
  type DictationModelChoice,
} from "@opengeni/react/desktop-dictation";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { Notice } from "@opengeni/react/ui/notice";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { useEffect, useRef, useState } from "react";

export function ComputerUseRoute() {
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
            <DictationSettings />
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

/**
 * Dictation's settings, with the workspace dictations go to and, for each
 * shortcut, that workspace's voice input models. Open settings on a failed
 * dictation comes here with `#dictation`.
 */
function DictationSettings() {
  const { client } = useAppContext();
  const { status } = useDesktopDictation();
  const workspaces = useDictationWorkspaces();
  const workspaceId = useDictationHome(status, workspaces)?.workspaceId ?? null;
  const hash = useLocation({ select: (location) => location.hash });
  const anchor = useRef<HTMLDivElement>(null);
  const shown = status !== null;
  useEffect(() => {
    if (hash === "dictation" && shown) anchor.current?.scrollIntoView({ block: "start" });
  }, [hash, shown]);
  const [models, setModels] = useState<{
    workspaceId: string;
    models: readonly DictationModelChoice[];
  } | null>(null);
  useEffect(() => {
    if (!workspaceId) return;
    let live = true;
    void client.getClientConfig({ workspaceId }).then(
      (config) => {
        if (live) setModels({ workspaceId, models: config.voiceInput?.models ?? [] });
      },
      // Unread, the rows offer the workspace's default model rather than wait.
      () => {
        if (live) setModels({ workspaceId, models: [] });
      },
    );
    return () => {
      live = false;
    };
  }, [client, workspaceId]);
  const current = models?.workspaceId === workspaceId ? models.models : undefined;
  return (
    <div id="dictation" ref={anchor} className="scroll-mt-6">
      <DesktopDictationSettings
        workspaces={workspaces}
        models={current}
        modelsLoading={workspaceId !== null && current === undefined}
      />
    </div>
  );
}
