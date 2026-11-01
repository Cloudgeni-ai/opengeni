import { useCallback, useEffect, useState } from "react";
import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";
import { Section, SectionStack } from "@opengeni/react/ui/section";
import { SettingNavRow } from "@opengeni/react/ui/setting-row";
import { Skeleton } from "@opengeni/react/ui/skeleton";

import { availableValue, type AvailableLocation } from "./available-here-model";
import {
  EVERYWHERE_KINDS,
  loadSharedOverview,
  sharedFailedSentence,
  vaultDescription,
  vaultOpen,
  vaultsDescription,
  type SharedOverviewClient,
  type SharedOverviewResult,
  type SharedPlace,
} from "./shared-overview-model";

/** Where the page sends someone: a thing's own page, Models or Developer. */
export type SharedOverviewDestination = AvailableLocation | { page: "models" | "developer" };

type LoadState = { status: "loading" } | ({ status: "ready" } & SharedOverviewResult);

function useSharedOverview(client: SharedOverviewClient, workspaceId: string) {
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    // Never rejects: each kind's failure is reported on its own.
    void loadSharedOverview(client, workspaceId).then((result) => {
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

function EmptyRow({ children }: { children: string }) {
  return <p className="m-0 py-3 text-sm leading-5 text-fg-muted">{children}</p>;
}

/**
 * Organization settings › Shared: everything the organization shares with
 * its workspaces and where each works. Models and their payers have their own
 * page; machines, rigs, Skills and Knowledge work everywhere; each vault works
 * where its "Available in" says. Each row opens the thing's own page.
 */
export function SharedOverview({
  client,
  organizationName,
  place,
  canOpenDeveloper,
  onOpen,
}: {
  client: SharedOverviewClient;
  organizationName: string;
  place: SharedPlace;
  /** People who manage the organization's API keys, webhooks and credential provider. */
  canOpenDeveloper: boolean;
  onOpen: (destination: SharedOverviewDestination) => void;
}) {
  const { state, retry } = useSharedOverview(client, place.workspaceId);
  const models = (
    <Section title="Models">
      <SettingNavRow
        label="Models and who pays for them"
        description={`${organizationName}'s plans and keys, and workspace plans shared with other workspaces, each with where it works.`}
        onOpen={() => onOpen({ page: "models" })}
      />
    </Section>
  );
  const developer = canOpenDeveloper ? (
    <Section title="Developer">
      <SettingNavRow
        label="Webhooks and credential provider"
        description={`What products built on Opengeni use in ${organizationName}'s workspaces.`}
        onOpen={() => onOpen({ page: "developer" })}
      />
    </Section>
  ) : null;
  const everywhereTitle = "In every workspace";
  const everywhereDescription = `${organizationName}'s machines, rigs, Skills and Knowledge work in every workspace, Personal workspaces included. Organization owners manage them.`;

  if (state.status === "loading") {
    return (
      <SectionStack>
        {models}
        <LoadingRows title={everywhereTitle} />
        {developer}
      </SectionStack>
    );
  }
  // Nothing loaded at all: one notice, not a list of every kind.
  if (state.failed.length === EVERYWHERE_KINDS.length + 1) {
    return (
      <SectionStack>
        {models}
        {/* Wrapped: a stack spaces its children, which must not reach into the notice's box. */}
        <div>
          <Notice
            tone="waiting"
            title="Couldn't load what's shared"
            action={<RetryButton onRetry={retry} />}
          >
            {state.failureMessage}
          </Notice>
        </div>
        {developer}
      </SectionStack>
    );
  }

  const vaultsFailed = state.failed.includes("vault");
  const everywhereFailed = EVERYWHERE_KINDS.every((kind) => state.failed.includes(kind));
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
            {sharedFailedSentence(state.failed)} Everything else is below.
          </Notice>
        </div>
      ) : null}
      {everywhereFailed ? null : (
        <Section title={everywhereTitle} description={everywhereDescription}>
          {state.everywhere.map((thing) => (
            <SettingNavRow
              key={thing.key}
              label={thing.name}
              value={availableValue(thing) || undefined}
              onOpen={() => onOpen(thing.open)}
            />
          ))}
          {state.everywhere.length === 0 ? (
            <EmptyRow>{`None yet. Machines, rigs, Skills and Knowledge that ${organizationName} adds show up here.`}</EmptyRow>
          ) : null}
        </Section>
      )}
      {vaultsFailed ? null : (
        <Section title="Vaults" description={vaultsDescription(state.vaultCoverage, place)}>
          {state.vaults.map((vault) => {
            const open = vaultOpen(vault, place);
            return (
              <SettingNavRow
                key={vault.id}
                label={vault.name}
                description={vaultDescription(vault, place)}
                value={vault.state ?? undefined}
                disabled={!open}
                onOpen={() => {
                  if (!open) return;
                  onOpen({
                    page: "vault",
                    vaultId: vault.id,
                    ...(open.workspaceId === place.workspaceId
                      ? {}
                      : { workspaceId: open.workspaceId }),
                  });
                }}
              />
            );
          })}
          {state.vaults.length === 0 ? (
            <EmptyRow>
              {state.vaultCoverage === "all"
                ? `${organizationName} has no vaults yet.`
                : `None work in ${place.personal ? "your Personal workspace" : place.workspaceName}.`}
            </EmptyRow>
          ) : null}
        </Section>
      )}
      {developer}
    </SectionStack>
  );
}
