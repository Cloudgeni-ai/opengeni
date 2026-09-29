import type { KnowledgeEntryScope, KnowledgeEntrySummary } from "@opengeni/sdk";
import { Navigate } from "@tanstack/react-router";
import {
  BrainCircuitIcon,
  FolderPlusIcon,
  GraduationCapIcon,
  PlusIcon,
  UploadIcon,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { ContentPage } from "@/components/ui/content-layout";
import { DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@/components/ui/line-tabs";
import { MoreMenu } from "@/components/ui/page-actions";
import { PageHeader } from "@/components/ui/page-header";
import { useAppContext } from "@/context";
import { isPersonalWorkspace } from "@/lib/managed-self-context";
import { orgLabel } from "@/lib/org";
import {
  canManageWorkspaceSettings,
  hasAccountPermission,
  hasWorkspacePermission,
} from "@/lib/permissions";

import { errorText, useArchiveKnowledge } from "./knowledge-data";
import { AddKnowledgePage, EntryEditPage, EntryPage, NewCollectionDialog } from "./knowledge-entry";
import {
  IdentityPage,
  InstructionsEditPage,
  InstructionsHistoryPage,
  InstructionsPage,
  InstructionsTab,
  useWorkspaceInstructions,
} from "./knowledge-instructions";
import {
  LearningPage,
  learningSummary,
  reviewEmptyLine,
  useLearningDefaults,
} from "./knowledge-learning";
import {
  initialLibraryView,
  LibraryTab,
  type EntryRowActions,
  type LibraryView,
} from "./knowledge-library";
import {
  useKnowledgeNavigation,
  type KnowledgeSearch,
  type KnowledgeTab,
} from "./knowledge-navigation";
import { ReviewItemPage, ReviewList, useReviewFlow, useReviewQueue } from "./knowledge-review";
import { UploadFilesDialog } from "./knowledge-upload";

/* ----------------------------------------------------------------------------
   Knowledge: one rail page with tabs Library, Instructions and Review (n),
   built like every resource page: a header with one primary action (Add
   knowledge) and a ⋯ menu, a toolbar, and flat lists of rows. Every entry,
   each change waiting for review, the instructions, Learning, Add knowledge,
   Edit and History open as their own pages in the content area with a back
   link. The URL says which one, so each page can be linked and the browser's
   back button works.
   -------------------------------------------------------------------------- */

const TAB_LABEL: Record<KnowledgeTab, string> = {
  library: "Knowledge",
  instructions: "Instructions",
  review: "Review",
};

export function KnowledgePage({
  workspaceId,
  search,
}: {
  workspaceId: string;
  search: KnowledgeSearch;
}) {
  const context = useAppContext();
  const workspace = context.workspaces.find((each) => each.id === workspaceId) ?? null;
  const personal = isPersonalWorkspace(workspace, context.managedSelfContext);
  const workspaceName = personal
    ? "your Personal workspace"
    : (workspace?.name ?? "this workspace");
  const organizationName = workspace?.accountId
    ? orgLabel(workspace.accountId, context.accessContext.accountGrants)
    : null;
  const canEdit = hasWorkspacePermission(context.accessContext, workspaceId, "documents:manage");
  const canWriteOrganization = Boolean(
    workspace?.accountId &&
    hasAccountPermission(context.accessContext, workspace.accountId, "account:admin"),
  );
  const canManageWorkspace = canManageWorkspaceSettings(
    context.accessContext,
    workspace,
    context.managedSelfContext,
  );
  const canEditInstructions = hasWorkspacePermission(
    context.accessContext,
    workspaceId,
    "workspace:admin",
  );
  const canUpload =
    context.clientConfig.fileUploads.enabled &&
    canEdit &&
    hasWorkspacePermission(context.accessContext, workspaceId, "files:upload");

  const nav = useKnowledgeNavigation(workspaceId);
  const [library, setLibrary] = useState<LibraryView>(() => initialLibraryView(personal));
  const [refresh, setRefresh] = useState(0);
  const changed = useCallback(() => setRefresh((value) => value + 1), []);
  const [uploadOpen, setUploadOpen] = useState(false);
  const [collectionOpen, setCollectionOpen] = useState(false);
  const [libraryEmpty, setLibraryEmpty] = useState(false);

  // Old links: Files is a Library filter now, the Review flag is a tab.
  const legacyFiles = search.view === "files";
  const legacyReview = search.review === true && search.view !== "review";
  useEffect(() => {
    if (legacyFiles) {
      setLibrary((current) => ({ ...current, filters: { type: ["source"] } }));
      nav.replace(search.file ? { file: search.file } : {});
    } else if (legacyReview) {
      nav.replace({ view: "review" });
    }
  }, [legacyFiles, legacyReview, nav, search.file]);

  const tab: KnowledgeTab =
    search.view === "instructions" || search.view === "review" || legacyReview
      ? legacyReview
        ? "review"
        : search.view === "review"
          ? "review"
          : "instructions"
      : "library";

  const queue = useReviewQueue(workspaceId, refresh);
  const review = useReviewFlow({
    queue,
    openKey: search.proposal ?? null,
    open: (key, { replace }) =>
      key ? nav.openProposal(key, { replace }) : nav.showTab("review", { replace }),
    onChanged: changed,
  });
  const shared = useLearningDefaults(workspaceId, personal ? "personal" : "workspace");
  const mine = useLearningDefaults(workspaceId, "personal");
  const instructions = useWorkspaceInstructions(workspaceId);
  const archive = useArchiveKnowledge(workspaceId, changed);

  const createScope: KnowledgeEntryScope =
    library.scope !== "all" &&
    (library.scope !== "organization" || canWriteOrganization) &&
    !(personal && library.scope !== "personal")
      ? library.scope
      : personal
        ? "personal"
        : "workspace";

  const entryLink = useCallback(
    (id: string) => `/workspaces/${workspaceId}/state?entry=${encodeURIComponent(id)}`,
    [workspaceId],
  );
  const rowActions: EntryRowActions = useMemo(
    () => ({
      canEdit: (entry: KnowledgeEntrySummary) =>
        canEdit && (entry.scope !== "organization" || canWriteOrganization),
      onOpen: (entry: KnowledgeEntrySummary) => nav.openEntry(entry.id),
      onArchive: (entry: KnowledgeEntrySummary) =>
        void archive({
          id: entry.id,
          title: entry.revision.title,
          version: entry.version,
          publishedRevisionId: entry.revision.id,
        }),
      onRestore: (entry: KnowledgeEntrySummary) => {
        void context.client
          .restoreKnowledgeEntry(workspaceId, {
            operationId: crypto.randomUUID(),
            entryId: entry.id,
            revisionId: entry.revision.id,
            expectedVersion: entry.version,
          })
          .then(() => {
            toast(`Restored ${entry.revision.title}. Agents use it again.`);
            changed();
          })
          .catch((reason: unknown) =>
            toast.error(`Couldn't restore ${entry.revision.title}`, {
              description: errorText(reason),
            }),
          );
      },
      linkFor: (entry: KnowledgeEntrySummary) => entryLink(entry.id),
    }),
    [archive, canEdit, canWriteOrganization, changed, context.client, entryLink, nav, workspaceId],
  );

  // Pages opened in place move focus to their title; the list gets its scroll back.
  const scroller = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const pageKey = search.page
    ? `${search.page}:${search.entry ?? ""}`
    : search.entry
      ? `entry:${search.entry}:${search.revision ?? ""}`
      : search.proposal
        ? `proposal:${search.proposal}`
        : `tab:${tab}`;
  const firstRender = useRef(true);
  const previousKey = useRef(pageKey);
  useLayoutEffect(() => {
    const leaving = previousKey.current;
    previousKey.current = pageKey;
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    if (leaving === pageKey) return;
    const root = scroller.current;
    if (!root) return;
    if (pageKey.startsWith("tab:")) {
      root.scrollTop = leaving.startsWith("tab:") ? root.scrollTop : listScroll.current;
    } else {
      root.scrollTop = 0;
      const heading = root.querySelector<HTMLElement>("h1");
      if (heading) {
        if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
        heading.classList.add("outline-none");
        heading.focus({ preventScroll: true });
      }
    }
  }, [pageKey]);
  const rememberScroll = () => {
    if (pageKey.startsWith("tab:")) listScroll.current = scroller.current?.scrollTop ?? 0;
  };
  const withScroll =
    <A extends unknown[]>(fn: (...args: A) => void) =>
    (...args: A) => {
      rememberScroll();
      fn(...args);
    };

  if (search.view === "skills") {
    return (
      <Navigate
        to="/workspaces/$workspaceId/plugins"
        params={{ workspaceId }}
        search={{ section: "skills" }}
        replace
      />
    );
  }

  const backToTab = () => nav.showTab(tab);
  const openEntry = (id: string, revision?: string) =>
    nav.openEntry(id, { ...(revision ? { revision } : {}), from: tab });

  const subpage = (() => {
    if (search.page === "learning") {
      return (
        <LearningPage
          workspaceName={workspace?.name ?? "this workspace"}
          organizationName={organizationName}
          personal={personal}
          canManageWorkspace={canManageWorkspace}
          shared={shared}
          mine={mine}
          onClose={backToTab}
        />
      );
    }
    if (search.page === "instructions") {
      return (
        <InstructionsPage
          workspaceId={workspaceId}
          workspaceName={workspaceName}
          personal={personal}
          canEdit={canEditInstructions}
          instructions={instructions}
          onBack={() => nav.showTab("instructions")}
          onEdit={() => nav.openPage("edit-instructions", { view: "instructions" })}
          onOpenHistory={() => nav.openPage("instructions-history", { view: "instructions" })}
        />
      );
    }
    if (search.page === "identity") {
      return (
        <IdentityPage
          workspaceId={workspaceId}
          canManageOrganization={canWriteOrganization}
          onBack={() => nav.showTab("instructions")}
        />
      );
    }
    if (search.page === "edit-instructions" && canEditInstructions) {
      return (
        <InstructionsEditPage
          workspaceName={workspace?.name ?? "this workspace"}
          personal={personal}
          instructions={instructions}
          onClose={() => nav.openPage("instructions", { view: "instructions" })}
        />
      );
    }
    if (search.page === "instructions-history") {
      return (
        <InstructionsHistoryPage
          workspaceId={workspaceId}
          workspaceName={workspace?.name ?? "this workspace"}
          canEdit={canEditInstructions}
          instructions={instructions}
          onClose={() => nav.openPage("instructions", { view: "instructions" })}
        />
      );
    }
    if (search.proposal && tab === "review") {
      return (
        <ReviewItemPage
          workspaceId={workspaceId}
          flow={review}
          loading={queue.loading}
          onBack={() => nav.showTab("review")}
          onOpenEntry={(id) => nav.openEntry(id, { from: "review" })}
        />
      );
    }
    if (search.page === "add" && canEdit) {
      return (
        <AddKnowledgePage
          workspaceId={workspaceId}
          workspaceName={workspace?.name ?? "this workspace"}
          personal={personal}
          canWriteOrganization={canWriteOrganization}
          defaultScope={createScope}
          {...(search.collection ? { collectionId: search.collection } : {})}
          onClose={() =>
            search.collection ? nav.openEntry(search.collection) : nav.showTab("library")
          }
          onCreated={(id) => {
            changed();
            nav.replace({ entry: id });
          }}
        />
      );
    }
    if (search.page === "edit" && search.entry && canEdit) {
      const entryId = search.entry;
      return (
        <EntryEditPage
          workspaceId={workspaceId}
          entryId={entryId}
          canEdit={canEdit}
          onClose={() => nav.openEntry(entryId)}
          onSaved={() => {
            changed();
            nav.replace({ entry: entryId });
          }}
        />
      );
    }
    if (search.entry) {
      return (
        <EntryPage
          workspaceId={workspaceId}
          entryId={search.entry}
          {...(search.revision ? { revisionId: search.revision } : {})}
          canEdit={canEdit}
          canWriteOrganization={canWriteOrganization}
          refresh={refresh}
          backLabel={tab === "library" ? "Knowledge" : TAB_LABEL[tab]}
          onBack={backToTab}
          onOpenEntry={openEntry}
          onEdit={(id) => nav.openPage("edit", { entry: id })}
          onAddInCollection={(collection) => nav.openPage("add", { collection })}
          onOpenReview={() => nav.showTab("review")}
          onChanged={changed}
          onArchive={async (record) => {
            await archive({
              id: record.id,
              title: record.revision.entry.title,
              version: record.version,
              publishedRevisionId: record.publishedRevisionId,
            });
          }}
          entryLink={entryLink}
          rowActions={{ ...rowActions, onOpen: (entry) => openEntry(entry.id) }}
        />
      );
    }
    return null;
  })();

  if (subpage) {
    return (
      <ContentPage
        ref={scroller}
        width="standard"
        className="max-w-none px-0 py-0 pb-0 sm:px-0 lg:px-0"
      >
        {subpage}
      </ContentPage>
    );
  }

  const waiting = review.items.length;
  const showReview = waiting > 0 || tab === "review";
  const openLearning = withScroll(() => nav.openPage("learning", { view: tab }));
  const showAdd = canEdit && !(tab === "library" && libraryEmpty);

  return (
    <ContentPage ref={scroller} width="standard" className="pt-6">
      <LineTabs
        value={tab}
        onValueChange={(value) => nav.showTab(value as KnowledgeTab)}
        className="min-w-0"
      >
        <PageHeader
          icon={<BrainCircuitIcon />}
          title="Knowledge"
          description="What your agents know and how they learn"
          actions={
            <>
              {showAdd ? (
                <Button
                  type="button"
                  onClick={withScroll(() => nav.openPage("add"))}
                  className="pointer-coarse:h-11"
                >
                  <PlusIcon aria-hidden="true" />
                  Add knowledge
                </Button>
              ) : null}
              <MoreMenu label="More knowledge actions">
                {canUpload && !(tab === "library" && libraryEmpty) ? (
                  <DropdownMenuItem onSelect={() => setUploadOpen(true)}>
                    <UploadIcon />
                    Upload files
                  </DropdownMenuItem>
                ) : null}
                {canEdit ? (
                  <DropdownMenuItem onSelect={() => setCollectionOpen(true)}>
                    <FolderPlusIcon />
                    New collection
                  </DropdownMenuItem>
                ) : null}
                {canEdit ? <DropdownMenuSeparator /> : null}
                <DropdownMenuItem onSelect={openLearning}>
                  <GraduationCapIcon />
                  Learning
                  {shared.loading ? null : (
                    <span className="ml-auto pl-6 text-xs text-fg-subtle">
                      {learningSummary(shared.modes)}
                    </span>
                  )}
                </DropdownMenuItem>
              </MoreMenu>
            </>
          }
          tabs={
            <LineTabsList aria-label="Knowledge">
              <LineTabsTrigger value="library">Library</LineTabsTrigger>
              <LineTabsTrigger value="instructions">Instructions</LineTabsTrigger>
              {showReview ? (
                <LineTabsTrigger
                  value="review"
                  count={waiting ? `${waiting}${queue.partial ? "+" : ""}` : undefined}
                  countTone="attention"
                  countLabel={waiting ? `${waiting} waiting for review` : undefined}
                >
                  Review
                </LineTabsTrigger>
              ) : null}
            </LineTabsList>
          }
        />
        <LineTabsContent value="library">
          <LibraryTab
            workspaceId={workspaceId}
            view={library}
            onViewChange={setLibrary}
            {...(search.file ? { fileId: search.file } : {})}
            onClearFile={() => nav.replace({})}
            refresh={refresh}
            actions={{
              ...rowActions,
              onOpen: withScroll((entry: KnowledgeEntrySummary) => nav.openEntry(entry.id)),
            }}
            canAdd={canEdit}
            canUpload={canUpload}
            onAdd={withScroll(() => nav.openPage("add"))}
            onUpload={() => setUploadOpen(true)}
            onEmptyChange={setLibraryEmpty}
          />
        </LineTabsContent>
        <LineTabsContent value="instructions">
          <InstructionsTab
            workspaceId={workspaceId}
            workspaceName={workspaceName}
            personal={personal}
            instructions={instructions}
            onOpenInstructions={withScroll(() =>
              nav.openPage("instructions", { view: "instructions" }),
            )}
            onOpenIdentity={withScroll(() => nav.openPage("identity", { view: "instructions" }))}
            onGoToLibrary={() => nav.showTab("library")}
          />
        </LineTabsContent>
        {showReview ? (
          <LineTabsContent value="review" className="pt-6">
            <ReviewList
              items={review.items}
              queue={queue}
              onOpen={withScroll((item: { key: string }) => nav.openProposal(item.key))}
              hrefFor={(item) =>
                `/workspaces/${workspaceId}/state?view=review&proposal=${encodeURIComponent(item.key)}`
              }
              emptyDescription={reviewEmptyLine(shared.modes)}
              onOpenLearning={openLearning}
            />
          </LineTabsContent>
        ) : null}
      </LineTabs>
      {canUpload ? (
        <UploadFilesDialog
          open={uploadOpen}
          onOpenChange={setUploadOpen}
          workspaceId={workspaceId}
          workspaceName={workspace?.name ?? "this workspace"}
          personal={personal}
          canWriteOrganization={canWriteOrganization}
          defaultScope={createScope}
          onUploaded={() => {
            setLibrary((current) => ({ ...current, filters: { type: ["source"] } }));
            changed();
          }}
        />
      ) : null}
      {canEdit ? (
        <NewCollectionDialog
          open={collectionOpen}
          onOpenChange={setCollectionOpen}
          workspaceId={workspaceId}
          scope={createScope}
          onCreated={(id) => {
            changed();
            nav.openEntry(id);
          }}
        />
      ) : null}
    </ContentPage>
  );
}
