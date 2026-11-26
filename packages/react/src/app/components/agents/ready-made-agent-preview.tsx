/**
 * A ready-made agent before it is added (docs/agents.md): what it does and
 * won't do without asking, when it works, what it needs, and one Add agent.
 * Opening it adds nothing; Add creates the agent with its triggers off and
 * hands over to the host's setup page (`onAdded`).
 */
import { useEffect, useState } from "react";
import { CheckIcon, CircleIcon, PlusIcon } from "lucide-react";
import { agentInitialsAvatar, type Agent, type AgentTemplate } from "@opengeni/contracts";

import { apiErrorDetails, userErrorText } from "../../../ui/api-error";
import { Button } from "../../../ui/button";
import {
  DetailAside,
  DetailAsideItem,
  DetailPage,
  DetailPageBody,
  DetailPageHeader,
} from "../../../ui/detail-page";
import { DetailSkeleton } from "../../../ui/detail-sheet";
import { ErrorMessage } from "../../../ui/error-message";
import { MetaChip } from "../../../ui/meta-chip";
import { Section } from "../../../ui/section";
import { SettingRow } from "../../../ui/setting-row";
import { useAppContext } from "../../app-context";
import { t } from "../../lib/console-text";
import { toast } from "../../lib/toast";
import { SessionAvatar } from "../session/session-avatar";
import { readyMadeAgentSetup } from "./ready-made-agent-setup";
import { agentTriggerSentence, agentTriggerShapeOfSuggestion } from "./agent-trigger-words";

/** Reads one ready-made agent by its key: undefined while loading, null when there is none. */
export function useReadyMadeAgentTemplate(workspaceId: string, templateKey: string) {
  const { client } = useAppContext();
  const [template, setTemplate] = useState<AgentTemplate | null | undefined>(undefined);
  const [error, setError] = useState<unknown>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setTemplate(undefined);
    setError(null);
    client.listAgentTemplates(workspaceId).then(
      (list) => live && setTemplate(list.find((entry) => entry.key === templateKey) ?? null),
      (reason: unknown) => {
        if (!live) return;
        setError(reason);
        setTemplate(null);
      },
    );
    return () => {
      live = false;
    };
  }, [attempt, client, templateKey, workspaceId]);
  return { template, error, reload: () => setAttempt((count) => count + 1) };
}

export function ReadyMadeAgentPreview({
  workspaceId,
  templateKey,
  onBack,
  onAdded,
}: {
  workspaceId: string;
  templateKey: string;
  onBack: () => void;
  /** The agent was added, triggers off: open its setup. */
  onAdded: (agent: Agent) => void;
}) {
  const { client } = useAppContext();
  const { template, error, reload } = useReadyMadeAgentTemplate(workspaceId, templateKey);
  const [adding, setAdding] = useState(false);
  const back = { label: "Agents", onClick: onBack };
  if (template === undefined) {
    return (
      <DetailPage back={back}>
        <DetailSkeleton sections={3} />
      </DetailPage>
    );
  }
  if (template === null) {
    return (
      <DetailPage back={back}>
        {error ? (
          <ErrorMessage
            title="Couldn't load this agent"
            {...apiErrorDetails(error)}
            action={
              <Button type="button" variant="outline" size="sm" onClick={reload}>
                Try again
              </Button>
            }
          >
            {userErrorText(error)}
          </ErrorMessage>
        ) : (
          <ErrorMessage title="This ready-made agent isn't available">
            It may have been retired. Pick another from Agents.
          </ErrorMessage>
        )}
      </DetailPage>
    );
  }
  const setup = readyMadeAgentSetup(template);
  const now = new Date();
  const add = async () => {
    if (adding) return;
    setAdding(true);
    try {
      // Shared agents added in the app stay editable by everyone (docs/agents.md).
      const agent = await client.createAgentFromTemplate(workspaceId, template.key, {
        editAccess: "everyone",
      });
      toast.success(`Added ${agent.name}`, {
        description: "Its triggers stay off until it's ready.",
      });
      onAdded(agent);
    } catch (caught) {
      toast.error(`Couldn't add ${template.name}`, { description: userErrorText(caught) });
      setAdding(false);
    }
  };
  return (
    <DetailPage back={back}>
      <DetailPageHeader
        leading={
          <SessionAvatar
            avatar={template.avatar ?? agentInitialsAvatar(template.name, template.key)}
            name={template.name}
            workspaceId={workspaceId}
            seed={template.key}
            size="lg"
          />
        }
        title={template.name}
        chips={<MetaChip variant="soft">Ready-made</MetaChip>}
        meta={template.description ? [template.description] : undefined}
        actions={
          <Button
            type="button"
            size="sm"
            className="pointer-coarse:h-11"
            disabled={adding}
            onClick={() => void add()}
            data-ready-made-add=""
          >
            <PlusIcon />
            {adding ? "Adding…" : "Add agent"}
          </Button>
        }
      />
      <DetailPageBody
        aside={
          <DetailAside>
            {setup.costPerRun ? (
              <DetailAsideItem label="Cost">
                <span className="tabular-nums" data-ready-made-cost="">
                  {setup.costPerRun}
                </span>
              </DetailAsideItem>
            ) : null}
            <DetailAsideItem label="Nothing runs until">
              You turn it on after adding
            </DetailAsideItem>
            {setup.worksWellWith ? (
              <DetailAsideItem label="Works well with">
                <span data-ready-made-works-well-with="">{setup.worksWellWith}</span>
              </DetailAsideItem>
            ) : null}
          </DetailAside>
        }
      >
        <Section title="What it does" variant="group" data-ready-made-does="">
          {setup.does.map((line) => (
            <SettingRow
              key={`does:${line}`}
              label={
                <span className="flex items-start gap-2">
                  <CheckIcon
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-status-idle"
                  />
                  {line}
                </span>
              }
            />
          ))}
          {setup.wontDoWithoutAsking.map((line) => (
            <SettingRow
              key={`wont:${line}`}
              data-ready-made-wont=""
              label={
                <span className="flex items-start gap-2">
                  <CircleIcon
                    aria-hidden="true"
                    className="mt-0.5 size-4 shrink-0 text-fg-subtle"
                  />
                  {line}
                </span>
              }
            />
          ))}
        </Section>
        {template.suggestedTriggers.length > 0 ? (
          <Section title="When it works" variant="group" data-ready-made-when="">
            {template.suggestedTriggers.map((suggestion) => (
              <SettingRow
                key={suggestion.name}
                label={agentTriggerSentence(t, agentTriggerShapeOfSuggestion(suggestion), {
                  agentName: template.name,
                  now,
                })}
                description="Off until you turn it on"
              />
            ))}
          </Section>
        ) : null}
        {setup.needs.length > 0 ? (
          <Section title="What it needs" variant="group" data-ready-made-needs="">
            {setup.needs.map((need) => (
              <SettingRow
                key={need.key}
                data-ready-made-need={need.key}
                label={
                  <span className="flex flex-wrap items-center gap-2">
                    {need.label}
                    <MetaChip variant="soft">{need.required ? "Required" : "Optional"}</MetaChip>
                  </span>
                }
                description={need.detail ?? undefined}
              />
            ))}
          </Section>
        ) : null}
      </DetailPageBody>
    </DetailPage>
  );
}
