import { useMemo, useState } from "react";
import {
  BrainCircuitIcon,
  ChevronDownIcon,
  FileTextIcon,
  FolderPlusIcon,
  GraduationCapIcon,
  PlusIcon,
  UploadIcon,
  WandSparklesIcon,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { showUndoToast } from "@/components/ui/destructive-confirm";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { InlineHelp } from "@/components/ui/inline-help";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { PageHeader } from "@/components/ui/page-header";
import type { Revision } from "@/components/ui/revision-history";
import { StatusBadge } from "@/components/ui/status-badge";

import { KIT_NOW, skillCapabilities, type LearningMode } from "../../fixtures";
import { KitBlock } from "../../kit";
import { PicksLine, PreviewDataToggle, QuestionBar, QuestionToggle } from "./chrome";
import { AppFrame, ContentColumn, ViewFocus } from "./frame";
import {
  initialEntries,
  initialInstructionRevisions,
  initialLearning,
  initialReview,
  KNOWLEDGE_WORKSPACE,
  LEARNING_DESTINATION_LABEL,
  learningSummary,
  TYPE_LABEL,
  type LearningDestination,
  type LearningGroup,
  type LibraryEntry,
  type ReviewEntry,
} from "./knowledge-data";
import {
  AddKnowledgeForm,
  NewCollectionDialog,
  UploadFilesDialog,
  type KnowledgeTemplate,
  type NewEntry,
} from "./knowledge-forms";
import {
  InstructionsEditPage,
  InstructionsHistoryPage,
  InstructionsTab,
} from "./knowledge-instructions";
import { LearningPage } from "./knowledge-learning";
import {
  EntryDetail,
  EntryEditPage,
  INITIAL_LIBRARY_VIEW,
  LibraryTab,
  type EntryPatch,
  type LibraryView,
} from "./knowledge-library";
import { ReviewTab } from "./knowledge-review";
import { usePagePicks, wait, type PickedKey } from "./picks";

/* ----------------------------------------------------------------------------
   Knowledge (brief section 10, "Agent Knowledge"): one rail page with the
   Capabilities header and width, tabs Library / Instructions / Review. Every
   entry, Learning, Add knowledge, Edit and History open as their own pages
   in the content area with a back link. No side sheets.
   -------------------------------------------------------------------------- */

type Tab = "library" | "files" | "instructions" | "skills" | "review";
type PreviewState = "filled" | "empty" | "loading";

/** Which page the content area shows: the tabs, or one page you opened. */
type KnowledgeView =
  | { kind: "tabs" }
  | { kind: "entry"; id: string }
  | { kind: "edit-entry"; id: string }
  | { kind: "add"; prefill: KnowledgeTemplate | null }
  | { kind: "learning" }
  | { kind: "edit-instructions" }
  | { kind: "instructions-history" };

const TABS_VIEW: KnowledgeView = { kind: "tabs" };

function viewKey(view: KnowledgeView): string {
  return "id" in view ? `${view.kind}:${view.id}` : view.kind;
}

interface Questions {
  q28: "one-page" | "kept";
  q29: "header" | "settings";
  q30: "groups" | "switcher";
  q31: "history" | "none";
  q32: "identity" | "company";
}

const RECOMMENDED: Questions = {
  q28: "one-page",
  q29: "header",
  q30: "groups",
  q31: "history",
  q32: "identity",
};

const KNOWLEDGE_PICKS: readonly PickedKey[] = [
  "page-header",
  "tabs-toolbar",
  "list-row",
  "detail-sheet",
  "empty-state",
  "section",
  "setting-row",
  "segmented-control",
  "select",
  "status-badge",
  "form-dialog",
];

let createdCount = 0;

function newEntry(fields: NewEntry): LibraryEntry {
  createdCount += 1;
  const now = new Date(KIT_NOW.getTime() - 60_000).toISOString();
  return {
    id: `kn-new-${createdCount}`,
    title: fields.title,
    type: fields.type,
    typeLabel: TYPE_LABEL[fields.type],
    scope: fields.scope,
    collection: fields.collection ?? undefined,
    content: fields.content,
    updatedAt: now,
    updatedLabel: "Just now",
    author: "Bendik Hansen",
    status: "published",
    revisions: [
      {
        id: `kn-new-${createdCount}-r1`,
        author: "Bendik Hansen",
        createdAt: now,
        summary: "Created the entry",
        content: fields.content,
      },
    ],
  };
}

export function KnowledgePagePreview() {
  const picks = usePagePicks();
  const [questions, setQuestions] = useState<Questions>(RECOMMENDED);
  const [previewState, setPreviewState] = useState<PreviewState>("filled");
  const [tab, setTab] = useState<Tab>("library");
  const [entries, setEntries] = useState<LibraryEntry[]>(initialEntries);
  const [collections, setCollections] = useState<string[]>(["Incidents"]);
  const [review, setReview] = useState<ReviewEntry[]>(initialReview);
  const [instructions, setInstructions] = useState<Revision[]>(initialInstructionRevisions);
  const [learning, setLearning] = useState(initialLearning);
  const [libraryView, setLibraryView] = useState<LibraryView>(INITIAL_LIBRARY_VIEW);
  const [view, setView] = useState<KnowledgeView>(TABS_VIEW);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);

  const setQuestion = <K extends keyof Questions>(key: K, value: Questions[K]) =>
    setQuestions((current) => ({ ...current, [key]: value }));

  const organizationWord = questions.q32 === "identity" ? "Organization" : "Company";
  const identityName = questions.q32 === "identity" ? "Organization identity" : "Company knowledge";
  const pendingCount = previewState === "empty" ? 0 : review.length;
  const viewedEntry =
    view.kind === "entry" || view.kind === "edit-entry"
      ? (entries.find((entry) => entry.id === view.id) ?? null)
      : null;
  const openEntry = (id: string | null) => setView(id ? { kind: "entry", id } : TABS_VIEW);
  const openAdd = (template?: KnowledgeTemplate) =>
    setView({ kind: "add", prefill: template ?? null });
  const openLearning = () => setView({ kind: "learning" });
  const libraryEmpty = previewState === "empty";

  const summary = learningSummary(learning.shared);
  const reviewModesOn = (
    Object.entries(learning.shared) as Array<[LearningDestination, LearningMode]>
  )
    .filter(([, mode]) => mode === "review_first")
    .map(([destination]) => destination);

  /* ------------------------------------------------------------ actions */

  const updateEntry = (id: string, patch: (entry: LibraryEntry) => LibraryEntry) =>
    setEntries((current) => current.map((entry) => (entry.id === id ? patch(entry) : entry)));

  const archive = (entry: LibraryEntry) => {
    const before = entry.status;
    updateEntry(entry.id, (current) => ({ ...current, status: "archived" }));
    showUndoToast({
      title: `Archived ${entry.title}`,
      description: "Agents stop using it. It stays under Filter › Archived.",
      onUndo: () => updateEntry(entry.id, (current) => ({ ...current, status: before })),
    });
  };

  const restore = (entry: LibraryEntry) => {
    updateEntry(entry.id, (current) => ({ ...current, status: "published" }));
    toast(`Restored ${entry.title}. Agents can use it again.`);
  };

  const saveEntry = async (entry: LibraryEntry, patch: EntryPatch) => {
    await wait(600);
    const now = new Date(KIT_NOW.getTime() - 30_000).toISOString();
    updateEntry(entry.id, (current) => ({
      ...current,
      ...patch,
      typeLabel: TYPE_LABEL[patch.type],
      updatedAt: now,
      author: "Bendik Hansen",
      revisions:
        patch.content === current.content
          ? current.revisions
          : [
              {
                id: `${current.id}-r${current.revisions.length + 1}`,
                author: "Bendik Hansen",
                createdAt: now,
                summary: "Edited the text",
                content: patch.content,
              },
              ...current.revisions,
            ],
    }));
    toast("Saved. Agents use the new text from the next message.");
  };

  const restoreEntryRevision = async (entry: LibraryEntry, revision: Revision) => {
    await wait(500);
    const before = entry;
    const now = new Date(KIT_NOW.getTime() - 20_000).toISOString();
    updateEntry(entry.id, (current) => ({
      ...current,
      content: revision.content,
      updatedAt: now,
      revisions: [
        {
          id: `${current.id}-r${current.revisions.length + 1}`,
          author: "Bendik Hansen",
          createdAt: now,
          summary: `Restored the version from ${revision.author}`,
          content: revision.content,
        },
        ...current.revisions,
      ],
    }));
    showUndoToast({
      title: "Restored an earlier version",
      onUndo: () => updateEntry(entry.id, () => before),
    });
  };

  const saveInstructions = async (content: string) => {
    await wait(700);
    setInstructions((current) => [
      {
        id: `rev-${current.length + 1}`,
        author: "Bendik Hansen",
        createdAt: new Date(KIT_NOW.getTime() - 30_000).toISOString(),
        summary: "Edited the instructions",
        content,
      },
      ...current,
    ]);
  };

  const restoreInstructions = async (revision: Revision) => {
    await wait(500);
    const before = instructions;
    setInstructions((current) => [
      {
        id: `rev-${current.length + 1}`,
        author: "Bendik Hansen",
        createdAt: new Date(KIT_NOW.getTime() - 20_000).toISOString(),
        summary: `Restored the version from ${revision.author}`,
        content: revision.content,
      },
      ...current,
    ]);
    showUndoToast({ title: "Restored an earlier version", onUndo: () => setInstructions(before) });
  };

  const approve = (item: ReviewEntry, editedText?: string) => {
    const before = { review, entries, instructions };
    setReview((current) => current.filter((each) => each.id !== item.id));
    const text = editedText ?? item.proposed;
    const now = new Date(KIT_NOW.getTime() - 10_000).toISOString();
    if (item.kind === "knowledge" && item.entryId) {
      updateEntry(item.entryId, (entry) => ({
        ...entry,
        content: text,
        updatedAt: now,
        revisions: [
          {
            id: `${entry.id}-r${entry.revisions.length + 1}`,
            author: "OpenGeni",
            createdAt: now,
            summary: `Approved from chat ${item.origin.name}`,
            content: text,
          },
          ...entry.revisions,
        ],
      }));
    } else if (item.kind === "instruction") {
      setInstructions((current) => [
        {
          id: `rev-${current.length + 1}`,
          author: "OpenGeni",
          createdAt: now,
          summary: `Approved from schedule ${item.origin.name}`,
          content: text,
        },
        ...current,
      ]);
    }
    showUndoToast({
      title: `Approved: ${item.title}`,
      description:
        item.kind === "skill" ? "Release notes is now a skill in Capabilities." : undefined,
      onUndo: () => {
        setReview(before.review);
        setEntries(before.entries);
        setInstructions(before.instructions);
      },
    });
  };

  const reject = (item: ReviewEntry) => {
    const before = review;
    setReview((current) => current.filter((each) => each.id !== item.id));
    showUndoToast({ title: `Rejected: ${item.title}`, onUndo: () => setReview(before) });
  };

  const changeLearning = (
    group: LearningGroup,
    destination: LearningDestination,
    mode: LearningMode,
  ) =>
    setLearning((current) => ({ ...current, [group]: { ...current[group], [destination]: mode } }));

  const create = (fields: NewEntry) => {
    const entry = newEntry(fields);
    setEntries((current) => [entry, ...current]);
    if (previewState === "empty") setPreviewState("filled");
    setTab("library");
    setView({ kind: "entry", id: entry.id });
    toast(`Added ${entry.title} to the Library`);
  };

  const upload = (names: string[]) => {
    const created = names.map((name) =>
      newEntry({
        title: name
          .replace(/\.[a-z]+$/i, "")
          .replace(/[-_]+/g, " ")
          .replace(/^./, (first) => first.toUpperCase()),
        content: `Uploaded file. Agents read ${name} when it's relevant.`,
        scope: "workspace",
        collection: null,
        type: "note",
      }),
    );
    setEntries((current) => [
      ...created.map((entry, index) => ({
        ...entry,
        type: "note" as const,
        typeLabel: TYPE_LABEL.note,
        source: { kind: "file" as const, name: names[index]! },
      })),
      ...current,
    ]);
    if (previewState === "empty") setPreviewState("filled");
    setTab("library");
    toast(names.length === 1 ? `Uploaded ${names[0]}` : `Uploaded ${names.length} files`);
  };

  /* ------------------------------------------------------------ header */

  const learningButton =
    questions.q29 === "header" ? (
      <Button
        type="button"
        variant="outline"
        onClick={openLearning}
        disabled={previewState === "loading"}
        className="pointer-coarse:h-11"
      >
        <GraduationCapIcon aria-hidden="true" />
        Learning: {summary}
      </Button>
    ) : null;

  const addMenu =
    libraryEmpty && tab === "library" && picks.empty.variant === "page" ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild disabled={previewState === "loading"}>
          <Button type="button" className="pointer-coarse:h-11">
            <PlusIcon aria-hidden="true" />
            Add
            <ChevronDownIcon aria-hidden="true" className="-mr-1 opacity-80" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-48">
          <DropdownMenuItem onSelect={() => openAdd()}>
            <PlusIcon />
            Add knowledge
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setUploadOpen(true)}>
            <UploadIcon />
            Upload files
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => setCollectionOpen(true)}>
            <FolderPlusIcon />
            New collection
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    );

  const showReviewTab = pendingCount > 0 || tab === "review";
  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: "library", label: "Library" },
    ...(questions.q28 === "kept" ? [{ id: "files" as const, label: "Files" }] : []),
    { id: "instructions", label: "Instructions" },
    ...(questions.q28 === "kept" ? [{ id: "skills" as const, label: "Skills" }] : []),
    ...(showReviewTab ? [{ id: "review" as const, label: "Review", count: pendingCount }] : []),
  ];

  const reviewNames = reviewModesOn.map((each) => LEARNING_DESTINATION_LABEL[each]);
  const learningLine =
    reviewNames.length === 3
      ? "These wait for you because Learning is set to Review first."
      : reviewNames.length > 0
        ? `These wait for you because ${reviewNames.join(" and ")} ${reviewNames.length === 1 ? "is" : "are"} set to Review first.`
        : "Agents save changes on their own right now, so new ones won't wait here.";

  const pageContent = (
    <LineTabs value={tab} onValueChange={(value) => setTab(value as Tab)} className="min-w-0">
      <PageHeader
        icon={<BrainCircuitIcon />}
        variant={picks.header.variant}
        showIcon={picks.header.railPageIcon}
        title="Knowledge"
        description="What your agents know and how they learn"
        actions={
          <>
            {learningButton}
            {addMenu}
          </>
        }
        tabs={
          <LineTabsList variant={picks.tabVariant} aria-label="Knowledge">
            {tabs.map((each) => (
              <LineTabsTrigger
                key={each.id}
                value={each.id}
                count={each.count ? each.count : undefined}
                countTone="attention"
                countLabel={each.count ? `${each.count} waiting for review` : undefined}
              >
                {each.label}
              </LineTabsTrigger>
            ))}
          </LineTabsList>
        }
      />
      <LineTabsContent value="library">
        <LibraryTab
          picks={picks}
          entries={entries}
          collections={collections}
          view={libraryView}
          onViewChange={setLibraryView}
          state={previewState}
          organizationWord={organizationWord}
          openId={null}
          onOpen={openEntry}
          onArchive={archive}
          onRestore={restore}
          onAddKnowledge={openAdd}
          onUpload={() => setUploadOpen(true)}
        />
      </LineTabsContent>
      {questions.q28 === "kept" ? (
        <>
          <LineTabsContent value="files">
            <FilesTab
              entries={entries}
              onOpen={(id) => {
                setTab("library");
                openEntry(id);
              }}
            />
          </LineTabsContent>
          <LineTabsContent value="skills">
            <SkillsTab />
          </LineTabsContent>
        </>
      ) : null}
      <LineTabsContent value="instructions">
        <InstructionsTab
          picks={picks}
          revisions={instructions}
          onEdit={() => setView({ kind: "edit-instructions" })}
          onOpenHistory={() => setView({ kind: "instructions-history" })}
          showHistory={questions.q31 === "history"}
          identityName={identityName}
          onGoToLibrary={() => setTab("library")}
          state={previewState}
        />
      </LineTabsContent>
      <LineTabsContent value="review">
        <ReviewTab
          picks={picks}
          items={review}
          state={previewState}
          onApprove={approve}
          onReject={reject}
          learningLine={learningLine}
          learningLink={
            questions.q29 === "header"
              ? { label: "Change it", onClick: openLearning }
              : { label: "Change it in Settings › Agent learning", href: "#settings-learning" }
          }
        />
      </LineTabsContent>
    </LineTabs>
  );

  const back = () => setView(TABS_VIEW);

  const viewContent = () => {
    if (view.kind === "add") {
      return (
        <AddKnowledgeForm
          onClose={back}
          picks={picks}
          entries={entries}
          collections={collections}
          onCreate={create}
          prefill={view.prefill}
        />
      );
    }
    if (view.kind === "edit-entry" && viewedEntry) {
      return (
        <EntryEditPage
          entry={viewedEntry}
          picks={picks}
          onClose={() => openEntry(viewedEntry.id)}
          onSave={saveEntry}
        />
      );
    }
    if (view.kind === "edit-instructions") {
      return (
        <InstructionsEditPage
          current={previewState === "empty" ? "" : (instructions[0]?.content ?? "")}
          onClose={() => {
            setTab("instructions");
            back();
          }}
          onSave={saveInstructions}
        />
      );
    }
    if (view.kind === "entry" && viewedEntry) {
      return (
        <EntryDetail
          entry={viewedEntry}
          picks={picks}
          organizationWord={organizationWord}
          onClose={back}
          onEdit={(entry) => setView({ kind: "edit-entry", id: entry.id })}
          onArchive={archive}
          onRestore={restore}
          onRestoreRevision={restoreEntryRevision}
        />
      );
    }
    if (view.kind === "learning") {
      return (
        <LearningPage
          onClose={back}
          picks={picks}
          learning={learning}
          onChange={changeLearning}
          layout={questions.q30}
        />
      );
    }
    if (view.kind === "instructions-history") {
      return (
        <InstructionsHistoryPage
          revisions={instructions}
          onClose={() => {
            setTab("instructions");
            back();
          }}
          onRestore={restoreInstructions}
        />
      );
    }
    return <ContentColumn width="wide">{pageContent}</ContentColumn>;
  };

  return (
    <div className="flex min-w-0 flex-col gap-8">
      <KitBlock
        title="Try it"
        description="Open an entry, search for “eu”, switch to By collection, archive something and undo it, approve the three changes in Review, edit the instructions and restore the old version, and change Learning. Everything is local to this preview."
      >
        <div className="flex min-w-0 flex-col gap-5">
          <QuestionBar
            total={5}
            changed={
              (Object.keys(RECOMMENDED) as Array<keyof Questions>).filter(
                (key) => questions[key] !== RECOMMENDED[key],
              ).length
            }
            description="Bendik hasn't answered these yet. Flip one to see the other answer in the page."
          >
            <QuestionToggle
              id="Q28"
              question="One page: Library, Instructions and Review"
              options={[
                { value: "one-page", label: "Yes" },
                { value: "kept", label: "Keep Files and Skills tabs" },
              ]}
              value={questions.q28}
              recommended="one-page"
              onChange={(value) => setQuestion("q28", value)}
            />
            <QuestionToggle
              id="Q29"
              question="Learning lives in the Knowledge header"
              options={[
                { value: "header", label: "Yes" },
                { value: "settings", label: "Stays in Settings" },
              ]}
              value={questions.q29}
              recommended="header"
              onChange={(value) => setQuestion("q29", value)}
            />
            <QuestionToggle
              id="Q30"
              question="Learning shows two labelled groups"
              options={[
                { value: "groups", label: "Two groups" },
                { value: "switcher", label: "One switcher" },
              ]}
              value={questions.q30}
              recommended="groups"
              onChange={(value) => setQuestion("q30", value)}
            />
            <QuestionToggle
              id="Q31"
              question="Instructions have history with Restore"
              options={[
                { value: "history", label: "Yes" },
                { value: "none", label: "No" },
              ]}
              value={questions.q31}
              recommended="history"
              onChange={(value) => setQuestion("q31", value)}
            />
            <QuestionToggle
              id="Q32"
              question="Say “Organization”, not “Company”"
              options={[
                { value: "identity", label: "Organization" },
                { value: "company", label: "Company" },
              ]}
              value={questions.q32}
              recommended="identity"
              onChange={(value) => setQuestion("q32", value)}
            />
          </QuestionBar>
          <div className="flex min-w-0 flex-col gap-3 @4xl/kit-section:flex-row @4xl/kit-section:items-start @4xl/kit-section:justify-between @4xl/kit-section:gap-8">
            <PicksLine picks={picks} keys={KNOWLEDGE_PICKS} />
            <PreviewDataToggle
              options={[
                { value: "filled", label: "Content" },
                { value: "empty", label: "Nothing yet" },
                { value: "loading", label: "Loading" },
              ]}
              value={previewState}
              onChange={setPreviewState}
            />
          </div>
        </div>
      </KitBlock>

      <AppFrame
        label="Knowledge page"
        active="knowledge"
        workspaceName={KNOWLEDGE_WORKSPACE.name}
        knowledgeAttention={pendingCount}
        onNavigate={(id) => {
          if (id === "knowledge") {
            setView(TABS_VIEW);
            setTab(pendingCount > 0 ? "review" : "library");
          }
        }}
        mobileTitle="Knowledge"
      >
        {() => <ViewFocus viewKey={viewKey(view)}>{viewContent()}</ViewFocus>}
      </AppFrame>

      <UploadFilesDialog open={uploadOpen} onOpenChange={setUploadOpen} onUpload={upload} />
      <NewCollectionDialog
        open={collectionOpen}
        onOpenChange={setCollectionOpen}
        collections={collections}
        onCreate={(name) => {
          setCollections((current) => [...current, name]);
          setLibraryView((current) => ({ ...current, layout: "collections" }));
          setTab("library");
          toast(`Created the ${name} collection`);
        }}
      />
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Q28, the other answer: Files and Skills stay as tabs.
   -------------------------------------------------------------------------- */

function FilesTab({ entries, onOpen }: { entries: LibraryEntry[]; onOpen: (id: string) => void }) {
  const files = useMemo(() => entries.filter((entry) => entry.source?.kind === "file"), [entries]);
  return (
    <div className="flex min-w-0 flex-col gap-4 pt-6">
      <InlineHelp icon>
        Today's Files tab. With Q28 answered Yes, these are the Library's Files filter instead.
      </InlineHelp>
      <RowList label="Files">
        {files.map((entry) => (
          <ListRow
            key={entry.id}
            leading={<LogoTile icon={<FileTextIcon />} />}
            title={entry.source?.name ?? entry.title}
            description={`Source of ${entry.title}`}
            meta={["PDF", "Workspace"]}
            onOpen={() => onOpen(entry.id)}
            indicator="open"
          />
        ))}
      </RowList>
    </div>
  );
}

function SkillsTab() {
  return (
    <div className="flex min-w-0 flex-col gap-4 pt-6">
      <InlineHelp icon>
        The same list as Capabilities › Skills. With Q28 answered Yes, skills live only there.
      </InlineHelp>
      <RowList label="Skills">
        {skillCapabilities.map((skill) => (
          <ListRow
            key={skill.id}
            leading={<LogoTile icon={<WandSparklesIcon />} />}
            title={skill.name}
            description={skill.description}
            meta={[skill.byLine]}
            control={
              skill.status === "installed" ? (
                <StatusBadge variant="dot" status="installed" />
              ) : undefined
            }
            onOpen={() => toast(`${skill.name} opens in Capabilities`)}
            indicator={skill.status === "installed" ? undefined : "add"}
          />
        ))}
      </RowList>
    </div>
  );
}
