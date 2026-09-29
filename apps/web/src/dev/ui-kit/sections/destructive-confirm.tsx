import { Fragment, useState, type ReactNode } from "react";
import { ArchiveIcon, KeyRoundIcon, Trash2Icon } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DestructiveConfirm,
  DestructiveConfirmPanel,
  UndoToast,
  showUndoToast,
  type ConfirmDependency,
  type DestructiveConfirmContentProps,
} from "@/components/ui/destructive-confirm";
import { ListRow, RowList } from "@/components/ui/list-row";
import { LogoTile } from "@/components/ui/logo-tile";
import { PageHeader } from "@/components/ui/page-header";
import { Alternative, Fork, KitBlock, KitSection, StateCell, StatesGrid, UsageNotes } from "../kit";
import {
  apiKeys,
  blockedDeleteVariableSet,
  currentWorkspace,
  knowledgeEntries,
  scheduleById,
  schedules,
  variableSetById,
  variableSets,
} from "../fixtures";

/* ----------------------------------------------------------------------------
   Content, all from the fixtures.
   -------------------------------------------------------------------------- */

const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

const staging = variableSetById("vs-staging-database");
const stagingNames = staging.variables.map((variable) => variable.name);
const awsSchedule = scheduleById("sched-aws-cost");
const ciKey = apiKeys[0]!;
const outage = knowledgeEntries.find((entry) => entry.id === "kn-checkout-outage")!;

/** DATABASE_URL, PGUSER and PGSSLMODE, with each name in mono. */
function listNames(names: string[]): ReactNode {
  return names.map((name, index) => (
    <Fragment key={name}>
      {index === 0 ? null : index === names.length - 1 ? " and " : ", "}
      <span className="font-mono text-xs">{name}</span>
    </Fragment>
  ));
}

const DELETE_STAGING: DestructiveConfirmContentProps = {
  title: `Delete ${staging.name}?`,
  consequences: [
    <>
      Its {staging.variables.length} variables are deleted: {listNames(stagingNames)}.
    </>,
    "No chat, schedule or environment uses it, so nothing else changes.",
    "This can't be undone.",
  ],
  confirmLabel: "Delete variable set",
  pendingLabel: "Deleting…",
};

const AWS_DEPENDENCIES: ConfirmDependency[] = [
  {
    id: awsSchedule.id,
    kind: "schedule",
    kindLabel: "Schedule",
    name: awsSchedule.name,
    detail: awsSchedule.cadenceLabel,
    href: "/dev/ui-kit?section=page-schedules",
  },
];

const BLOCKED_AWS: DestructiveConfirmContentProps = {
  variant: "blocked",
  title: `${blockedDeleteVariableSet.name} is in use`,
  description: "Remove it from this schedule first. Then you can delete it.",
  dependencies: AWS_DEPENDENCIES,
};

const workspaceSets = variableSets.filter((set) => set.scope === "workspace").length;

const DELETE_WORKSPACE: DestructiveConfirmContentProps = {
  variant: "type-to-confirm",
  title: `Delete ${currentWorkspace.name}?`,
  consequences: [
    `Deletes every chat, ${schedules.length} schedules and ${workspaceSets} variable sets in ${currentWorkspace.name}.`,
    "Maria Chen and CI bot lose access. Their Personal workspaces stay.",
    "This can't be undone.",
  ],
  confirmText: currentWorkspace.name,
  confirmPlaceholder: "Workspace name",
  confirmLabel: "Delete workspace",
  pendingLabel: "Deleting…",
};

const REVOKE_KEY: DestructiveConfirmContentProps = {
  title: `Revoke ${ciKey.name}?`,
  consequences: [
    <>
      Anything using <span className="font-mono text-xs">{ciKey.prefixLabel}</span> stops working
      right away. It was last used {ciKey.lastUsedLabel}.
    </>,
    "The key stays listed as revoked, so you can see what it was.",
    "This can't be undone. Create a new key to replace it.",
  ],
  confirmLabel: "Revoke key",
  pendingLabel: "Revoking…",
};

const ARCHIVE_ICON = <ArchiveIcon />;

function PanelStage({ children }: { children: ReactNode }) {
  return <div className="flex min-w-0 justify-center">{children}</div>;
}

/* ----------------------------------------------------------------------------
   The page the confirm opens over, so every version is judged in context.
   -------------------------------------------------------------------------- */

function SetsPage({ hide }: { hide?: string }) {
  return (
    <div className="mx-auto w-full max-w-[960px] px-4 pt-6 pb-6 sm:px-6">
      <PageHeader
        title="Variable sets"
        description="Environment variables and secrets your agents get in their sandbox."
      />
      <div className="mt-6">
        <RowList variant="resource" label="Variable sets">
          {variableSets
            .slice(0, 4)
            .filter((set) => set.id !== hide)
            .map((set) => (
              <ListRow
                key={set.id}
                leading={<LogoTile icon={<KeyRoundIcon />} name={set.name} />}
                title={set.name}
                description={set.description}
                meta={[set.variablesLabel, set.usageLabel]}
                indicator="open"
                onOpen={() => undefined}
              />
            ))}
        </RowList>
      </div>
    </div>
  );
}

/** The confirm over the dimmed page. The page behind is out of the tab order. */
function OverPage({ children }: { children: ReactNode }) {
  return (
    <div className="relative isolate min-w-0 overflow-hidden bg-bg">
      <div aria-hidden="true" inert className="absolute inset-x-0 top-0">
        <SetsPage />
      </div>
      <div aria-hidden="true" className="absolute inset-0 bg-black/50" />
      <div className="relative flex min-w-0 justify-center px-4 pt-12 pb-16">{children}</div>
    </div>
  );
}

function Caption({ children }: { children: ReactNode }) {
  return (
    <p className="border-t border-border px-4 py-3 text-xs leading-4.5 text-fg-muted">{children}</p>
  );
}

/* ----------------------------------------------------------------------------
   C: Undo instead. The list right after the delete, and the toast.
   -------------------------------------------------------------------------- */

function UndoAlternative() {
  const [deleted, setDeleted] = useState(true);
  return (
    <div className="flex min-h-[480px] min-w-0 flex-col bg-bg">
      <SetsPage hide={deleted ? staging.id : undefined} />
      <div className="mt-auto flex justify-end px-4 pb-4 sm:px-6">
        {deleted ? (
          <UndoToast
            icon={<Trash2Icon />}
            title={`Deleted ${staging.name}`}
            description={`${staging.variables.length} variables`}
            onUndo={() => setDeleted(false)}
            onDismiss={() => undefined}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            onClick={() => setDeleted(true)}
            className="pointer-coarse:h-11"
          >
            Delete {staging.name} again
          </Button>
        )}
      </div>
    </div>
  );
}

/* ----------------------------------------------------------------------------
   Live examples.
   -------------------------------------------------------------------------- */

type Example = "staging" | "blocked" | "workspace" | "key" | "failing" | null;

function LiveExamples() {
  const [open, setOpen] = useState<Example>(null);
  const [archived, setArchived] = useState(false);
  const close = (next: boolean) => {
    if (!next) setOpen(null);
  };
  return (
    <KitBlock
      title="Open the real thing"
      description="Focus starts on Cancel, or on the name field when one must be typed. Enter confirms once the name matches."
    >
      <div className="flex flex-wrap gap-2">
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen("staging")}
          className="pointer-coarse:h-11"
        >
          Delete {staging.name}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen("blocked")}
          className="pointer-coarse:h-11"
        >
          Delete {blockedDeleteVariableSet.name}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen("workspace")}
          className="pointer-coarse:h-11"
        >
          Delete {currentWorkspace.name}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen("key")}
          className="pointer-coarse:h-11"
        >
          Revoke {ciKey.name}
        </Button>
        <Button
          type="button"
          variant="outline"
          onClick={() => setOpen("failing")}
          className="pointer-coarse:h-11"
        >
          Delete that fails
        </Button>
        <Button
          type="button"
          variant="outline"
          disabled={archived}
          onClick={() => {
            setArchived(true);
            showUndoToast({
              title: `Archived ${outage.title}`,
              description: "Find it under Archived in the Library.",
              icon: ARCHIVE_ICON,
              onUndo: () => setArchived(false),
            });
          }}
          className="pointer-coarse:h-11"
        >
          <ArchiveIcon aria-hidden="true" />
          {archived ? "Archived" : `Archive ${outage.title}`}
        </Button>
      </div>
      <DestructiveConfirm
        open={open === "staging"}
        onOpenChange={close}
        {...DELETE_STAGING}
        onConfirm={() => wait(900)}
      />
      <DestructiveConfirm open={open === "blocked"} onOpenChange={close} {...BLOCKED_AWS} />
      <DestructiveConfirm
        open={open === "workspace"}
        onOpenChange={close}
        {...DELETE_WORKSPACE}
        onConfirm={() => wait(1200)}
      />
      <DestructiveConfirm
        open={open === "key"}
        onOpenChange={close}
        {...REVOKE_KEY}
        onConfirm={() => wait(700)}
      />
      <DestructiveConfirm
        open={open === "failing"}
        onOpenChange={close}
        {...DELETE_STAGING}
        onConfirm={async () => {
          await wait(900);
          throw new Error(`Couldn't delete ${staging.name}. Check your connection and try again.`);
        }}
      />
    </KitBlock>
  );
}

/* ----------------------------------------------------------------------------
   The section.
   -------------------------------------------------------------------------- */

export default function DestructiveConfirmSection() {
  return (
    <KitSection sectionKey="destructive-confirm">
      <Fork layout="stack">
        <Alternative id="a" padding={false}>
          <OverPage>
            <DestructiveConfirmPanel {...DELETE_STAGING} />
          </OverPage>
          <Caption>One step. Focus starts on Cancel, so Enter never deletes by accident.</Caption>
        </Alternative>
        <Alternative id="b" padding={false}>
          <OverPage>
            <DestructiveConfirmPanel
              {...DELETE_STAGING}
              variant="type-to-confirm"
              confirmText={staging.name}
              confirmPlaceholder="Variable set name"
            />
          </OverPage>
          <Caption>
            Typing the name slows people down on purpose. Worth it for a workspace or a person; too
            much for a variable set nothing uses.
          </Caption>
        </Alternative>
        <Alternative id="c" padding={false}>
          <UndoAlternative />
          <Caption>
            No dialog: the row goes and Undo stays for 8 seconds. Needs a soft delete on the server.
            Today a deleted variable set is gone for good.
          </Caption>
        </Alternative>
      </Fork>

      <LiveExamples />

      <StatesGrid
        columns={2}
        description="Every state of the recommended consequence list, plus the blocked and typed variants it pairs with."
      >
        <StateCell label="Default" align="stretch">
          <PanelStage>
            <DestructiveConfirmPanel {...DELETE_STAGING} />
          </PanelStage>
        </StateCell>
        <StateCell
          label="Blocked"
          align="stretch"
          note="No destructive button. Each dependency links to where it can be removed."
        >
          <PanelStage>
            <DestructiveConfirmPanel {...BLOCKED_AWS} />
          </PanelStage>
        </StateCell>
        <StateCell
          label="Typing"
          align="stretch"
          note="The field starts empty; the placeholder never shows the name."
        >
          <PanelStage>
            <DestructiveConfirmPanel {...DELETE_WORKSPACE} defaultTypedValue="Design prev" />
          </PanelStage>
        </StateCell>
        <StateCell label="Typed" align="stretch">
          <PanelStage>
            <DestructiveConfirmPanel
              {...DELETE_WORKSPACE}
              defaultTypedValue={currentWorkspace.name}
            />
          </PanelStage>
        </StateCell>
        <StateCell
          label="Submitting"
          align="stretch"
          note="Cancel, Escape and outside clicks wait until it finishes."
        >
          <PanelStage>
            <DestructiveConfirmPanel {...REVOKE_KEY} pending />
          </PanelStage>
        </StateCell>
        <StateCell
          label="Failed"
          align="stretch"
          note="The error stays inside the dialog so it can be retried."
        >
          <PanelStage>
            <DestructiveConfirmPanel
              {...DELETE_STAGING}
              error={`Couldn't delete ${staging.name}. Check your connection and try again.`}
            />
          </PanelStage>
        </StateCell>
        <StateCell label="Long names" align="stretch">
          <PanelStage>
            <DestructiveConfirmPanel
              variant="blocked"
              title="Datadog synthetics private location credentials is in use"
              description="Remove it from these first. Then you can delete it."
              dependencies={[
                {
                  id: "a",
                  kind: "schedule",
                  kindLabel: "Schedule",
                  name: "Monthly access review for every production AWS account and the Datadog EU site",
                  detail: "Every month on day 1 at 09:00 · Oslo",
                  href: "/dev/ui-kit?section=page-schedules",
                },
                {
                  id: "b",
                  kind: "environment",
                  kindLabel: "Sandbox environment default",
                  name: "Platform CI",
                  href: "/dev/ui-kit?section=page-variable-sets",
                },
                {
                  id: "c",
                  kind: "chat",
                  kindLabel: "Chat",
                  name: "Why did the synthetics checks for checkout-api start failing on 14 Sep?",
                  detail: "Yesterday",
                  href: "/dev/ui-kit?section=page-knowledge",
                },
              ]}
            />
          </PanelStage>
        </StateCell>
        <StateCell
          label="Mobile 390"
          align="stretch"
          width="mobile"
          note="Full-width stacked buttons, 44px on touch screens."
        >
          <DestructiveConfirmPanel {...DELETE_WORKSPACE} className="max-w-none" />
        </StateCell>
        <StateCell
          label="Undo toast"
          span="full"
          align="center"
          note="For reversible actions only. Stays 8 seconds; Undo restores and closes it."
        >
          <UndoToast
            icon={<ArchiveIcon />}
            title={`Archived ${outage.title}`}
            description="Find it under Archived in the Library."
            onUndo={() => undefined}
            onDismiss={() => undefined}
          />
        </StateCell>
      </StatesGrid>

      <UsageNotes
        use={[
          "A permanent delete, revoke or disconnect: name it in the title and list what happens",
          "Type to confirm only when the impact is wide: a workspace, removing someone from the organization",
          "When something blocks the action: open the blocked version instead of disabling the button",
        ]}
        avoid={[
          "Reversible actions like archive or remove from a list: do it and offer Undo",
          "“Are you sure?” with no consequences, or a masked ID in the title",
          "A disabled trash icon with a hover tooltip",
        ]}
      />
    </KitSection>
  );
}
