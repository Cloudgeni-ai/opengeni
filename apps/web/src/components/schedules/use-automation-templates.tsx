/**
 * Templates as the automation pages read them: the built-in ones, the ones
 * saved in this workspace, and the art each built-in one shows.
 */
import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  GitPullRequestIcon,
  MessageSquareCodeIcon,
  NotebookPenIcon,
  SunriseIcon,
  TagsIcon,
  TrendingUpIcon,
} from "lucide-react";

import type { AutomationTemplate } from "@opengeni/react/automations";
import { useAppContext } from "@opengeni/react/app/app-context";
import { apiErrorFacts } from "@opengeni/react/ui/api-error";
import type { WorkspaceAutomationTemplate } from "@opengeni/sdk";

const TEMPLATE_ICONS: Record<string, ReactNode> = {
  "meeting-notes": <NotebookPenIcon />,
  "pr-review": <MessageSquareCodeIcon />,
  "issue-triage": <TagsIcon />,
  "morning-brief": <SunriseIcon />,
  "dependency-pr": <GitPullRequestIcon />,
  "cost-check": <TrendingUpIcon />,
};

/** A built-in template's own art; a saved one shows where its events come from. */
export function templateIcon(template: Pick<AutomationTemplate, "id">): ReactNode | undefined {
  return TEMPLATE_ICONS[template.id];
}

/** A link's `?template=`: a built-in template's id, or a saved one's. */
export const SAVED_TEMPLATE_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export type WorkspaceTemplatesState = {
  /** Undefined until the first read settles. */
  templates: WorkspaceAutomationTemplate[] | undefined;
  /** False on a server that doesn't keep templates. */
  supported: boolean;
  error: Error | null;
  reload: () => void;
  /** Shows a change made here without reading the list again. */
  replace: (
    update: (current: WorkspaceAutomationTemplate[]) => WorkspaceAutomationTemplate[],
  ) => void;
};

/** The templates saved in this workspace, read once. */
export function useWorkspaceTemplates(workspaceId: string): WorkspaceTemplatesState {
  const { client } = useAppContext();
  const [templates, setTemplates] = useState<WorkspaceAutomationTemplate[] | undefined>(undefined);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    client.listAutomationTemplates(workspaceId).then(
      (next) => {
        if (!live) return;
        setTemplates(next);
        setSupported(true);
        setError(null);
      },
      (reason: unknown) => {
        if (!live) return;
        if (apiErrorFacts(reason).status === 404) {
          setSupported(false);
          setTemplates([]);
          return;
        }
        setError(reason instanceof Error ? reason : new Error(String(reason)));
        setTemplates((current) => current ?? []);
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, client, workspaceId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const replace = useCallback(
    (update: (current: WorkspaceAutomationTemplate[]) => WorkspaceAutomationTemplate[]) =>
      setTemplates((current) => update(current ?? [])),
    [],
  );
  return { templates, supported, error, reload, replace };
}
