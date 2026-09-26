import { useState, type ReactNode } from "react";
import {
  ArrowUpRightIcon,
  Building2Icon,
  HistoryIcon,
  PencilIcon,
  ScrollTextIcon,
  SparklesIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  DetailBody,
  DetailFooter,
  DetailHeader,
  DetailSection,
  DetailSheet,
  DetailSheetContent,
} from "@/components/ui/detail-sheet";
import { Field, TextArea } from "@/components/ui/field";
import { FormDialog } from "@/components/ui/form-dialog";
import { HelpLink, InlineHelp } from "@/components/ui/inline-help";
import { LogoTile } from "@/components/ui/logo-tile";
import { MetaChip } from "@/components/ui/meta-chip";
import { RelativeTime } from "@/components/ui/relative-time";
import { RevisionHistory, type Revision } from "@/components/ui/revision-history";
import { Section, SectionStack } from "@/components/ui/section";
import { cn } from "@/lib/utils";

import { defaultModel, KIT_NOW, KIT_TIME_ZONE, organizationIdentity } from "../../fixtures";
import { KNOWLEDGE_WORKSPACE } from "./knowledge-data";
import type { PagePicks } from "./picks";

/* ----------------------------------------------------------------------------
   Instructions tab: what is always in the prompt. Organization identity
   (read-only here) and the workspace instructions, rendered as they read, with
   Edit, Ask OpenGeni and History.
   -------------------------------------------------------------------------- */

/** Headings, bullets and paragraphs, as they read. Enough for instructions. */
export function Markdown({ text, className }: { text: string; className?: string }) {
  const blocks: ReactNode[] = [];
  let bullets: string[] = [];
  const flush = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    blocks.push(
      <ul
        key={`list-${blocks.length}`}
        className="flex list-disc flex-col gap-1 pl-5 marker:text-fg-subtle"
      >
        {items.map((item, index) => (
          // oxlint-disable-next-line react/no-array-index-key -- lines of one static text
          <li key={index}>{item}</li>
        ))}
      </ul>,
    );
    bullets = [];
  };
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    const bullet = /^[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      bullets.push(bullet[1] ?? "");
      continue;
    }
    flush();
    if (!line) continue;
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    blocks.push(
      heading ? (
        <p key={`h-${blocks.length}`} className="font-semibold text-fg">
          {heading[1]}
        </p>
      ) : (
        <p key={`p-${blocks.length}`}>{line}</p>
      ),
    );
  }
  flush();
  return (
    <div className={cn("flex flex-col gap-2 text-sm leading-6 text-fg", className)}>{blocks}</div>
  );
}

function BlockHeader({
  icon,
  title,
  addon,
  meta,
  actions,
}: {
  icon: ReactNode;
  title: ReactNode;
  addon?: ReactNode;
  meta?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-start gap-x-4 gap-y-3">
      <div className="flex min-w-0 flex-1 basis-64 items-start gap-3">
        <LogoTile size="md" icon={icon} />
        <div className="min-w-0 pt-px">
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <h3 className="text-sm leading-5 font-medium text-fg">{title}</h3>
            {addon}
          </div>
          {meta ? <p className="text-xs leading-4.5 text-fg-muted">{meta}</p> : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 flex-wrap items-center gap-2">{actions}</div> : null}
    </div>
  );
}

export interface InstructionsTabProps {
  picks: PagePicks;
  revisions: Revision[];
  onSave: (content: string) => Promise<void>;
  onRestore: (revision: Revision) => Promise<void>;
  /** Q31: history with Restore. */
  showHistory: boolean;
  /** Q32: "Organization identity" or "Company knowledge". */
  identityName: string;
  onGoToLibrary: () => void;
  state: "filled" | "empty" | "loading";
}

export function InstructionsTab({
  picks,
  revisions,
  onSave,
  onRestore,
  showHistory,
  identityName,
  onGoToLibrary,
  state,
}: InstructionsTabProps) {
  const current = state === "empty" ? "" : (revisions[0]?.content ?? "");
  const latest = revisions[0];
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(current);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [askOpen, setAskOpen] = useState(false);
  const [ask, setAsk] = useState("");
  const [askError, setAskError] = useState<string | null>(null);
  const loading = state === "loading";
  const tooLong = draft.length > 4000;

  const startEdit = () => {
    setDraft(current);
    setError(null);
    setEditing(true);
  };

  const save = async () => {
    if (tooLong) {
      setError("Keep instructions under 4,000 characters. Move long procedures into a skill.");
      return;
    }
    setSaving(true);
    try {
      await onSave(draft.trim());
      setEditing(false);
      toast("Saved the workspace instructions. New messages use them.");
    } finally {
      setSaving(false);
    }
  };

  const instructionsMeta = latest ? (
    <>
      {revisions.length} {revisions.length === 1 ? "version" : "versions"} · Last edited{" "}
      <RelativeTime
        date={latest.createdAt ?? KIT_NOW}
        now={KIT_NOW}
        timeZone={KIT_TIME_ZONE}
        inSentence
      />{" "}
      by {latest.author}
    </>
  ) : (
    "Not set yet"
  );

  return (
    <div className="flex min-w-0 flex-col gap-6 pt-6">
      <SectionStack variant={picks.section}>
        <Section
          title="Always applied to every agent"
          description={`Added to every chat and schedule in ${KNOWLEDGE_WORKSPACE.name}, before anything agents look up.`}
          contentClassName={cn(picks.section === "open" && "divide-y divide-border")}
        >
          <div className="flex min-w-0 flex-col gap-3 py-4">
            <BlockHeader
              icon={<Building2Icon />}
              title={identityName}
              meta={organizationIdentity.editedLabel}
              actions={
                <HelpLink href="#organization-identity" className="text-sm leading-5">
                  Edit in organization settings
                  <ArrowUpRightIcon
                    aria-hidden="true"
                    className="ml-0.5 inline size-3.5 align-[-2px]"
                  />
                </HelpLink>
              }
            />
            {loading ? (
              <div className="h-12 animate-pulse rounded-[10px] bg-surface-2" />
            ) : (
              <div className="flex min-w-0 flex-col gap-1 pl-11 text-sm leading-6 text-fg @max-[559px]/main:pl-0">
                <p>{organizationIdentity.identity}</p>
                <p className="text-fg-muted">
                  <span className="font-medium text-fg">Mission. </span>
                  {organizationIdentity.mission}
                </p>
              </div>
            )}
          </div>
          <div className="flex min-w-0 flex-col gap-3 py-4">
            <BlockHeader
              icon={<ScrollTextIcon />}
              title="Workspace instructions"
              meta={state === "empty" ? "Not set yet" : instructionsMeta}
              actions={
                editing ? null : (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setAskOpen(true)}
                      disabled={loading}
                      className="pointer-coarse:h-11"
                    >
                      <SparklesIcon aria-hidden="true" />
                      Ask OpenGeni…
                    </Button>
                    {showHistory && revisions.length > 0 && state !== "empty" ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        onClick={() => setHistoryOpen(true)}
                        disabled={loading}
                        className="pointer-coarse:h-11"
                      >
                        <HistoryIcon aria-hidden="true" />
                        History
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={startEdit}
                      disabled={loading}
                      className="pointer-coarse:h-11"
                    >
                      <PencilIcon aria-hidden="true" />
                      {state === "empty" ? "Write instructions" : "Edit"}
                    </Button>
                  </>
                )
              }
            />
            {loading ? (
              <div className="ml-11 flex flex-col gap-2 @max-[559px]/main:ml-0">
                <div className="h-4 w-32 animate-pulse rounded-full bg-surface-2" />
                <div className="h-3.5 w-3/5 animate-pulse rounded-full bg-surface-2" />
                <div className="h-3.5 w-2/5 animate-pulse rounded-full bg-surface-2" />
              </div>
            ) : editing ? (
              <div className="flex min-w-0 flex-col gap-3 pl-11 @max-[559px]/main:pl-0">
                <Field
                  label="Instructions"
                  hint="Markdown. Headings and bullets read as they look. Agents follow these in every chat."
                  error={
                    error ?? (tooLong ? "Keep instructions under 4,000 characters." : undefined)
                  }
                  aside={`${draft.length.toLocaleString("en-US")} / 4,000`}
                >
                  <TextArea
                    mono
                    rows={7}
                    value={draft}
                    onChange={(event) => {
                      setDraft(event.target.value);
                      setError(null);
                    }}
                  />
                </Field>
                <div className="flex flex-wrap items-center justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    onClick={() => setEditing(false)}
                    disabled={saving}
                    className="pointer-coarse:h-11"
                  >
                    Cancel
                  </Button>
                  <Button
                    type="button"
                    onClick={() => void save()}
                    disabled={saving || draft.trim() === current.trim()}
                    className="pointer-coarse:h-11"
                  >
                    {saving ? "Saving…" : "Save instructions"}
                  </Button>
                </div>
              </div>
            ) : current ? (
              <Markdown text={current} className="pl-11 @max-[559px]/main:pl-0" />
            ) : (
              <p className="pl-11 text-sm text-fg-muted @max-[559px]/main:pl-0">
                No workspace instructions yet. Write how agents should work here, like review rules
                or the tone for pull requests.
              </p>
            )}
          </div>
        </Section>
      </SectionStack>
      <InlineHelp icon>
        Facts go in the <HelpLink onClick={onGoToLibrary}>Library</HelpLink>. Step-by-step
        procedures go in Skills, in <HelpLink href="#capabilities">Capabilities</HelpLink>.
      </InlineHelp>

      <DetailSheet open={historyOpen} onOpenChange={setHistoryOpen}>
        <DetailSheetContent>
          <DetailHeader
            leading={<LogoTile icon={<HistoryIcon />} />}
            title="Instructions history"
            subtitle={`${KNOWLEDGE_WORKSPACE.name} · ${revisions.length} versions`}
          />
          <DetailBody>
            <DetailSection description="Restoring saves that version again as the newest one, so you can always go back.">
              <RevisionHistory
                revisions={revisions}
                now={KIT_NOW}
                label="Workspace instructions history"
                onRestore={onRestore}
              />
            </DetailSection>
          </DetailBody>
          <DetailFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setHistoryOpen(false)}
              className="pointer-coarse:h-11"
            >
              Done
            </Button>
          </DetailFooter>
        </DetailSheetContent>
      </DetailSheet>

      <FormDialog
        open={askOpen}
        onOpenChange={(open) => {
          setAskOpen(open);
          if (!open) {
            setAsk("");
            setAskError(null);
          }
        }}
        size="sm"
        title="Ask OpenGeni to change the instructions"
        description="It starts a chat that proposes the change. You review it before it applies."
        submitLabel="Start chat"
        pendingLabel="Starting…"
        footerStart={`Uses ${defaultModel.displayLabel}`}
        onSubmit={async () => {
          if (!ask.trim()) {
            setAskError("Describe the change you want.");
            return false;
          }
          await new Promise((resolve) => setTimeout(resolve, 600));
          toast("Started a chat. The proposed change will show up in Review.");
          return true;
        }}
      >
        <Field label="What should change?" error={askError ?? undefined}>
          <TextArea
            rows={3}
            value={ask}
            placeholder="For example: pull requests need a linked Linear issue"
            onChange={(event) => {
              setAsk(event.target.value);
              setAskError(null);
            }}
          />
        </Field>
      </FormDialog>
    </div>
  );
}
