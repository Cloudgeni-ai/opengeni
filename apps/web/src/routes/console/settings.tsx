import type { ConsoleAuditEvent, ConsoleReviewLevel, ConsoleSettings } from "@opengeni/sdk";
import { useNavigate } from "@tanstack/react-router";
import { SettingsIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";

import { userErrorText } from "@opengeni/react/ui/api-error";
import { Button } from "@opengeni/react/ui/button";
import { ChoiceCard, ChoiceCards, ChoiceCardsSkeleton } from "@opengeni/react/ui/choice-cards";
import { ListRow, ListRowSkeleton, RowList } from "@opengeni/react/ui/list-row";
import { PageHeader } from "@opengeni/react/ui/page-header";
import { RelativeTime } from "@opengeni/react/ui/relative-time";
import { Section } from "@opengeni/react/ui/section";

import {
  ConsoleLoadError,
  ConsolePage,
  auditActionText,
  useConsole,
  useConsoleQuery,
} from "./console-shared";
import { OrganizationGeneralPage } from "@/components/organization/general-page";

import { ConsoleOrganizationProvider } from "./console-organization";

const REVIEW_LEVELS: { value: ConsoleReviewLevel; title: string; description: string }[] = [
  {
    value: "full",
    title: "Full transcripts",
    description: "Questions, answers, tool calls and feedback comments.",
  },
  {
    value: "metadata",
    title: "Metadata only",
    description: "Counts, cost, status and ratings. No message content.",
  },
  { value: "off", title: "Off", description: "No session list. Totals stay on Overview." },
];

function isReviewLevel(value: string): value is ConsoleReviewLevel {
  return value === "full" || value === "metadata" || value === "off";
}

export function ConsoleSettingsRoute() {
  const { client, organizationId } = useConsole();
  const settings = useConsoleQuery(
    (signal) => client.getConsoleSettings(organizationId, { signal }),
    [client, organizationId],
  );
  const [saved, setSaved] = useState<ConsoleSettings | null>(null);
  const [saving, setSaving] = useState<ConsoleReviewLevel | null>(null);
  const [auditRevision, setAuditRevision] = useState(0);
  useEffect(() => setSaved(null), [organizationId]);
  const current = saved ?? settings.data;
  const level = saving ?? current?.reviewLevel;

  async function change(next: ConsoleReviewLevel) {
    if (!current || next === current.reviewLevel || saving) return;
    setSaving(next);
    try {
      const updated = await client.updateConsoleSettings(organizationId, { reviewLevel: next });
      setSaved(updated);
      setAuditRevision((value) => value + 1);
      toast.success("Session review updated");
    } catch (error) {
      toast.error("Session review wasn't changed", { description: userErrorText(error) });
    } finally {
      setSaving(null);
    }
  }

  return (
    <ConsolePage>
      <PageHeader title="Settings" icon={<SettingsIcon />} />
      <ConsoleOrganizationProvider>
        <OrganizationGeneralPage />
      </ConsoleOrganizationProvider>
      {settings.error ? (
        <ConsoleLoadError error={settings.error} onRetry={settings.reload} />
      ) : (
        <>
          <Section title="Data and privacy">
            <div className="flex flex-col gap-3">
              {level ? (
                <ChoiceCards
                  variant="radio"
                  label="Session review"
                  description="What owners and admins see of end-user sessions in managed workspaces."
                  value={level}
                  disabled={saving !== null}
                  onValueChange={(value) => {
                    if (isReviewLevel(value)) void change(value);
                  }}
                >
                  {REVIEW_LEVELS.map((choice) => (
                    <ChoiceCard
                      key={choice.value}
                      value={choice.value}
                      title={choice.title}
                      description={choice.description}
                    />
                  ))}
                </ChoiceCards>
              ) : (
                <ChoiceCardsSkeleton count={3} variant="radio" label="Session review" />
              )}
              <p className="text-xs text-fg-muted">
                Only me chats of Opengeni users are never shown.
              </p>
            </div>
          </Section>
          <AuditLog key={`${organizationId}:${auditRevision}`} />
        </>
      )}
    </ConsolePage>
  );
}

const AUDIT_PAGE = 50;

function AuditLog() {
  const { client, organizationId, search } = useConsole();
  const navigate = useNavigate();
  const first = useConsoleQuery(
    (signal) => client.listConsoleAuditLog(organizationId, { limit: AUDIT_PAGE, signal }),
    [client, organizationId],
  );
  const [more, setMore] = useState<ConsoleAuditEvent[]>([]);
  const [cursor, setCursor] = useState<string | null | undefined>(undefined);
  const [loadingMore, setLoadingMore] = useState(false);
  const nextCursor = cursor === undefined ? (first.data?.nextCursor ?? null) : cursor;
  const events = [...(first.data?.events ?? []), ...more];

  async function loadMore() {
    if (!nextCursor) return;
    setLoadingMore(true);
    try {
      const page = await client.listConsoleAuditLog(organizationId, {
        limit: AUDIT_PAGE,
        cursor: nextCursor,
      });
      setMore((current) => [...current, ...page.events]);
      setCursor(page.nextCursor);
    } catch (error) {
      toast.error("Couldn't load more of the audit log", { description: userErrorText(error) });
    } finally {
      setLoadingMore(false);
    }
  }

  return (
    <Section title="Audit log" description="Every opened session and changed setting.">
      {first.error ? (
        <ConsoleLoadError error={first.error} onRetry={first.reload} />
      ) : !first.data ? (
        <ListRowSkeleton count={4} />
      ) : events.length === 0 ? (
        <p className="text-sm text-fg-muted">Nothing yet.</p>
      ) : (
        <div className="flex flex-col gap-4">
          <RowList
            variant="table"
            label="Audit log"
            nameLabel="Event"
            columns={[
              { id: "who", label: "Who", width: 160 },
              { id: "workspace", label: "Workspace", width: 140 },
              { id: "when", label: "When", width: 112, align: "end" },
            ]}
          >
            {events.map((event) => {
              const sessionId = event.sessionId;
              const workspaceId = event.workspaceId;
              return (
                <ListRow
                  key={event.id}
                  title={auditActionText(event.action)}
                  description={auditDetail(event)}
                  cells={{
                    who: event.actorLabel ?? shortSubject(event.actorSubjectId),
                    workspace: event.workspaceName ?? "—",
                    when: <RelativeTime date={event.createdAt} />,
                  }}
                  {...(sessionId && workspaceId
                    ? {
                        onOpen: () =>
                          void navigate({
                            to: "/console/sessions/$workspaceId/$sessionId",
                            params: { workspaceId, sessionId },
                            search,
                          }),
                      }
                    : {})}
                />
              );
            })}
          </RowList>
          {nextCursor ? (
            <div className="flex justify-center">
              <Button variant="outline" disabled={loadingMore} onClick={() => void loadMore()}>
                {loadingMore ? "Loading…" : "Load more"}
              </Button>
            </div>
          ) : null}
        </div>
      )}
    </Section>
  );
}

function shortSubject(subjectId: string): string {
  const subject = subjectId.replace(/^[a-z_]+:/u, "");
  return subject.length > 14 ? `${subject.slice(0, 12)}…` : subject;
}

const LEVEL_WORDS: Record<string, string> = {
  full: "Full transcripts",
  metadata: "Metadata only",
  off: "Off",
  managed: "Managed by product",
  team: "Team",
};

/** "Metadata only → Full transcripts" for a setting or kind change. */
function auditDetail(event: ConsoleAuditEvent): string | undefined {
  const { from, to } = event.detail;
  if (typeof to !== "string") return undefined;
  const toWord = LEVEL_WORDS[to] ?? to;
  return typeof from === "string" ? `${LEVEL_WORDS[from] ?? from} → ${toWord}` : toWord;
}
