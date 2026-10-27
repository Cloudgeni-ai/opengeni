/**
 * Bot templates as the app reads them: the ones saved in a workspace. A bot
 * is an ordinary long-lived chat with a name, description and avatar; a
 * template is where a new one starts. Starting from one opens a new chat whose
 * first message is the template's setup instructions.
 */
import { useCallback, useEffect, useState } from "react";
import {
  BotTemplateFile,
  botTemplateFile,
  type CreateBotTemplateRequest,
  type WorkspaceBotTemplate,
} from "@opengeni/contracts";

import { apiErrorFacts } from "../../ui/api-error";
import { useAppContext } from "../app-context";

export type BotTemplatesState = {
  /** Undefined until the first read settles. */
  templates: WorkspaceBotTemplate[] | undefined;
  /** False on a server that doesn't keep bot templates. */
  supported: boolean;
  error: Error | null;
  reload: () => void;
  /** Shows a change made here without reading the list again. */
  replace: (update: (current: WorkspaceBotTemplate[]) => WorkspaceBotTemplate[]) => void;
};

/** The bot templates saved in this workspace, read once per mount. */
export function useBotTemplates(
  workspaceId: string,
  options: { enabled?: boolean } = {},
): BotTemplatesState {
  const { client } = useAppContext();
  const enabled = options.enabled ?? true;
  const [templates, setTemplates] = useState<WorkspaceBotTemplate[] | undefined>(undefined);
  const [supported, setSupported] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!enabled) return;
    let live = true;
    client.listBotTemplates(workspaceId).then(
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
  }, [attempt, client, enabled, workspaceId]);
  const reload = useCallback(() => setAttempt((value) => value + 1), []);
  const replace = useCallback(
    (update: (current: WorkspaceBotTemplate[]) => WorkspaceBotTemplate[]) =>
      setTemplates((current) => update(current ?? [])),
    [],
  );
  return { templates, supported, error, reload, replace };
}

/** A template's file name: its name in lowercase words, then `.bot.json`. */
export function botTemplateFileName(template: Pick<WorkspaceBotTemplate, "name">): string {
  const slug = template.name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${slug || "bot"}.bot.json`;
}

/** Download a template as a file someone can import into their workspace. */
export function downloadBotTemplate(template: WorkspaceBotTemplate): void {
  const blob = new Blob([`${JSON.stringify(botTemplateFile(template), null, 2)}\n`], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = botTemplateFileName(template);
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/** The create request in an exported template file, or why it isn't one. */
export function parseBotTemplateFile(
  text: string,
): { ok: true; request: CreateBotTemplateRequest } | { ok: false; error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return {
      ok: false,
      error: "This file isn't a bot template. Choose a .bot.json file.",
    };
  }
  const parsed = BotTemplateFile.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error:
        "This file isn't a bot template this version can read. Export it again, then import that file.",
    };
  }
  const file = parsed.data;
  return {
    ok: true,
    request: {
      name: file.name,
      description: file.description,
      avatar: file.avatar,
      setupInstructions: file.setupInstructions,
    },
  };
}
