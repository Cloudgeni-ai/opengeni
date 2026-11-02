import { useCallback, useEffect, useState } from "react";
import { Button } from "@opengeni/react/ui/button";
import { Notice } from "@opengeni/react/ui/notice";
import { Section, SectionStack } from "@opengeni/react/ui/section";
import { SettingNavRow } from "@opengeni/react/ui/setting-row";
import { Skeleton } from "@opengeni/react/ui/skeleton";

import { KIND_LABELS, type AvailableLocation } from "./available-here-model";
import {
  SHARED_KINDS,
  coverageDescription,
  emptyGroupSentence,
  knowledgeDescription,
  loadSharedOverview,
  reachDescription,
  sharedFailedSentence,
  sharedOpen,
  skillsDescription,
  type SharedCompute,
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

/** Where a machine's or sandbox environment's row opens, given the workspace it opens in. */
function computeDestination(
  item: SharedCompute,
  workspaceId: string | undefined,
): SharedOverviewDestination {
  const elsewhere = workspaceId ? { workspaceId } : {};
  return item.kind === "machine"
    ? { page: "machines", ...elsewhere }
    : { page: "rig", rigId: item.id, ...elsewhere };
}

/**
 * Organization settings › Shared: everything the organization shares with
 * its workspaces and where each works. Models and their payers have their own
 * page; each machine, sandbox environment, vault, Skill and Knowledge entry
 * works only where its "Available in" says. Each row opens the thing's own
 * page, in a workspace where it works.
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
  const computeTitle = "Machines and sandbox environments";

  if (state.status === "loading") {
    return (
      <SectionStack>
        {models}
        <LoadingRows title={computeTitle} />
        {developer}
      </SectionStack>
    );
  }
  // Nothing loaded at all: one notice, not a list of every kind.
  if (state.failed.length === SHARED_KINDS.length) {
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

  const computeFailed = state.failed.includes("machine") && state.failed.includes("rig");
  const vaultsFailed = state.failed.includes("vault");
  const skillsFailed = state.failed.includes("skills");
  const knowledgeFailed = state.failed.includes("knowledge");
  const here = place.personal ? "your Personal workspace" : place.workspaceName;
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
      {computeFailed ? null : (
        <Section
          title={computeTitle}
          description={coverageDescription(state.computeCoverage, place)}
        >
          {state.compute.map((item) => {
            const open = sharedOpen(item.reach, place);
            return (
              <SettingNavRow
                key={item.key}
                label={item.name}
                description={reachDescription(item.reach, place)}
                value={KIND_LABELS[item.kind]}
                disabled={!open}
                onOpen={() => {
                  if (!open) return;
                  onOpen(
                    computeDestination(
                      item,
                      open.workspaceId === place.workspaceId ? undefined : open.workspaceId,
                    ),
                  );
                }}
              />
            );
          })}
          {state.compute.length === 0 ? (
            <EmptyRow>
              {emptyGroupSentence(
                state.computeCoverage,
                place,
                `${organizationName} has no machines or sandbox environments yet.`,
              )}
            </EmptyRow>
          ) : null}
        </Section>
      )}
      {vaultsFailed ? null : (
        <Section title="Vaults" description={coverageDescription(state.vaultCoverage, place)}>
          {state.vaults.map((vault) => {
            const open = sharedOpen(vault.availability, place);
            return (
              <SettingNavRow
                key={vault.id}
                label={vault.name}
                description={reachDescription(vault.availability, place)}
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
              {emptyGroupSentence(
                state.vaultCoverage,
                place,
                `${organizationName} has no vaults yet.`,
              )}
            </EmptyRow>
          ) : null}
        </Section>
      )}
      {skillsFailed && knowledgeFailed ? null : (
        <Section
          title="Skills and Knowledge"
          description="Each works only where its Available in says. Organization owners and admins manage them."
        >
          {state.skills ? (
            <SettingNavRow
              label="Skills"
              description={skillsDescription(state.skills, place)}
              value={String(state.skills.count)}
              onOpen={() => onOpen({ page: "plugins", section: "skills" })}
            />
          ) : null}
          {state.knowledgeHere ? (
            <SettingNavRow
              label="Knowledge"
              description={knowledgeDescription(place)}
              onOpen={() => onOpen({ page: "knowledge", scope: "organization" })}
            />
          ) : null}
          {!state.skills && !state.knowledgeHere ? (
            <EmptyRow>
              {skillsFailed
                ? `None of ${organizationName}'s Knowledge works in ${here}.`
                : knowledgeFailed
                  ? `None of ${organizationName}'s Skills work in ${here}.`
                  : `None of ${organizationName}'s Skills or Knowledge work in ${here}.`}
            </EmptyRow>
          ) : null}
        </Section>
      )}
      {developer}
    </SectionStack>
  );
}
