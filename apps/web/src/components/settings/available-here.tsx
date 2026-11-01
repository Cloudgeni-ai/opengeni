import { useCallback, useEffect, useState } from "react";
import { Button } from "@opengeni/react/ui/button";
import { EmptyState } from "@opengeni/react/ui/empty-state";
import { Notice } from "@opengeni/react/ui/notice";
import { Section, SectionStack } from "@opengeni/react/ui/section";
import { SettingNavRow } from "@opengeni/react/ui/setting-row";
import { Skeleton } from "@opengeni/react/ui/skeleton";

import {
  AVAILABLE_KINDS,
  availableDescription,
  availableGroups,
  availableValue,
  failedSentence,
  loadAvailableHere,
  type AvailableHereClient,
  type AvailableHereResult,
  type AvailableLocation,
  type AvailableNames,
} from "./available-here-model";

/** Where the page sends someone: a thing's own page, or the Models page. */
export type AvailableHereDestination = AvailableLocation | { page: "models" };

type LoadState = { status: "loading" } | ({ status: "ready" } & AvailableHereResult);

function useAvailableHere(client: AvailableHereClient, workspaceId: string) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    // Never rejects: each kind's failure is reported on its own.
    void loadAvailableHere(client, workspaceId).then((result) => {
      if (current) setState({ status: "ready", ...result });
    });
    return () => {
      current = false;
    };
  }, [attempt, client, workspaceId]);
  return { state, retry: useCallback(() => setAttempt((count) => count + 1), []) };
}

function RetryButton({ onRetry }: { onRetry: () => void }) {
  return (
    <Button type="button" size="sm" variant="outline" onClick={onRetry}>
      Try again
    </Button>
  );
}

function LoadingRows({ title }: { title: string }) {
  return (
    <Section title={title} aria-busy="true">
      {[0, 1, 2].map((key) => (
        <div key={key} className="flex flex-col gap-1.5 py-3">
          <Skeleton className="h-4 w-32" />
          <Skeleton className="h-3 w-56 max-w-full" />
        </div>
      ))}
    </Section>
  );
}

/**
 * Settings › Available here: everything agents in this workspace can use,
 * grouped by who it belongs to (this workspace, the organization or you),
 * with who manages it. Each row opens the thing's own page.
 */
export function AvailableHere({
  client,
  workspaceId,
  workspaceName,
  organizationName,
  personal,
  canOpenModels,
  onOpen,
}: {
  client: AvailableHereClient;
  workspaceId: string;
  workspaceName: string;
  organizationName: string;
  personal: boolean;
  /** Admins of this workspace, organization owners and admins, and anyone in their Personal workspace. */
  canOpenModels: boolean;
  onOpen: (destination: AvailableHereDestination) => void;
}) {
  const { state, retry } = useAvailableHere(client, workspaceId);
  const names: AvailableNames = {
    workspace: workspaceName,
    organization: organizationName,
    personal,
  };
  const models = (
    <Section title="Models">
      <SettingNavRow
        label="Models and who pays for them"
        description="Which models agents here can use, and the plans and keys that pay for them, each with who it belongs to."
        disabled={!canOpenModels}
        disabledReason={
          personal
            ? undefined
            : `Admins of ${workspaceName} and organization owners and admins manage these. You choose a model when you send a message.`
        }
        onOpen={() => onOpen({ page: "models" })}
      />
    </Section>
  );

  if (state.status === "loading") {
    return (
      <SectionStack>
        {models}
        <LoadingRows title={personal ? "Yours" : `Belongs to ${workspaceName}`} />
      </SectionStack>
    );
  }
  // Nothing loaded at all: one notice, not a list of every kind.
  if (state.failed.length === AVAILABLE_KINDS.length) {
    return (
      <SectionStack>
        {models}
        {/* Wrapped: a stack spaces its children, which must not reach into the notice's box. */}
        <div>
          <Notice
            tone="waiting"
            title="Couldn't load what's available here"
            action={<RetryButton onRetry={retry} />}
          >
            {state.failureMessage}
          </Notice>
        </div>
      </SectionStack>
    );
  }

  const groups = availableGroups(state.things, names);
  return (
    <SectionStack>
      {models}
      {state.failed.length > 0 ? (
        <div>
          <Notice
            tone="waiting"
            title="Some of this didn't load"
            action={<RetryButton onRetry={retry} />}
          >
            {failedSentence(state.failed)} Everything else is below.
          </Notice>
        </div>
      ) : null}
      {groups.length === 0 && state.failed.length === 0 ? (
        <EmptyState
          variant="page"
          title="Nothing else here yet"
          description={`Connectors, machines, rigs, vaults, Skills and Knowledge that agents in ${workspaceName} can use show up here, with who each belongs to.`}
        />
      ) : null}
      {groups.map((group) => (
        <Section key={group.owner} title={group.title} description={group.description}>
          {group.things.map((thing) => (
            <SettingNavRow
              key={thing.key}
              label={thing.name}
              description={availableDescription(thing, names) || undefined}
              value={availableValue(thing) || undefined}
              onOpen={() => onOpen(thing.open)}
            />
          ))}
        </Section>
      ))}
    </SectionStack>
  );
}
