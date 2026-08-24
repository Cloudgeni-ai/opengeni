import type { WorkspaceSessionToolDefaults } from "@opengeni/contracts";
import { ChevronDownIcon, FolderIcon, PlusIcon, SendIcon, SparklesIcon } from "lucide-react";
import { useState } from "react";

import { SessionToolPicker, type SessionToolSelection } from "@/components/pickers";
import { Button } from "@/components/ui/button";
import { WorkspaceCapabilityDefaultsView } from "@/components/workspace-capability-defaults";
import { firstPartySessionToolOptions, type McpServerOption } from "@/lib/session-tools";

const PREVIEW_SERVERS: McpServerOption[] = [
  { id: "files", name: "Files" },
  { id: "docs", name: "Document Search" },
  { id: "gmail", name: "Gmail" },
  { id: "linear", name: "Linear" },
];

const INITIAL_DEFAULTS: WorkspaceSessionToolDefaults = {
  mcpServerIds: PREVIEW_SERVERS.map((server) => server.id),
  firstPartyMcpTools: firstPartySessionToolOptions.map((tool) => tool.id),
};

/**
 * Public DEV approval gallery. It renders the exact production settings view
 * and session picker with fixture data; only the surrounding labels are demo
 * chrome. Nothing on this route is persisted.
 */
export function CapabilityUxV4Route() {
  const [defaults, setDefaults] = useState(INITIAL_DEFAULTS);
  const [revision, setRevision] = useState(1);
  const [selection, setSelection] = useState<SessionToolSelection>(() => ({
    mcpServerIds: new Set(INITIAL_DEFAULTS.mcpServerIds),
    firstPartyToolIds: new Set(INITIAL_DEFAULTS.firstPartyMcpTools),
  }));

  return (
    <main className="h-full overflow-y-auto bg-bg px-4 py-8 text-fg sm:px-6 lg:px-10">
      <div className="mx-auto max-w-6xl">
        <div className="mb-7 flex flex-wrap items-end justify-between gap-3 border-b border-border pb-5">
          <div>
            <p className="text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Local approval gallery
            </p>
            <h1 className="mt-1 text-xl font-semibold">Capability UX V4 implementation</h1>
            <p className="mt-1 max-w-2xl text-sm text-fg-muted">
              These are the production components with local fixture data. Changes stay on this
              page.
            </p>
          </div>
          <span className="rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-fg-muted">
            Not connected to a workspace
          </span>
        </div>

        <div className="grid items-start gap-8 lg:grid-cols-[minmax(0,1.15fr)_minmax(22rem,0.85fr)]">
          <section className="min-w-0">
            <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              Workspace settings
            </p>
            <WorkspaceCapabilityDefaultsView
              servers={PREVIEW_SERVERS}
              firstPartyTools={firstPartySessionToolOptions}
              defaults={defaults}
              revisionKey={String(revision)}
              canManage
              onSave={async (next) => {
                setDefaults(next);
                setRevision((current) => current + 1);
                return true;
              }}
            />
          </section>

          <section className="min-w-0 lg:sticky lg:top-8">
            <p className="mb-3 text-2xs font-semibold uppercase tracking-wider text-fg-subtle">
              New session composer
            </p>
            <div className="rounded-xl border border-border bg-surface p-3 shadow-sm">
              <textarea
                aria-label="Session prompt preview"
                placeholder="Describe a task for the agent…"
                className="min-h-28 w-full resize-none bg-transparent px-1 py-1 text-sm outline-none placeholder:text-fg-subtle"
              />
              <div className="mt-2 flex min-w-0 items-center gap-2">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  className="size-8 shrink-0 rounded-full sm:hidden"
                >
                  <PlusIcon className="size-3.5" />
                  <span className="sr-only">Session options</span>
                </Button>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 max-w-[10rem] shrink-0 gap-1.5 rounded-full border border-transparent px-2.5 text-xs max-sm:hidden"
                >
                  <SparklesIcon className="size-3.5 shrink-0" />
                  <span className="truncate">GPT-5.6 Sol</span>
                  <ChevronDownIcon className="size-3 shrink-0" />
                </Button>
                <SessionToolPicker
                  servers={PREVIEW_SERVERS}
                  firstPartyTools={firstPartySessionToolOptions}
                  selection={selection}
                  onChange={setSelection}
                  menuSide="bottom"
                  triggerClassName="min-w-0 shrink-0 max-sm:hidden"
                />
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-8 min-w-0 shrink-0 gap-1.5 rounded-full border border-transparent px-2.5 text-xs max-sm:hidden"
                >
                  <FolderIcon className="size-3.5 shrink-0" />
                  <span className="truncate">1 repository</span>
                  <ChevronDownIcon className="size-3 shrink-0" />
                </Button>
                <Button type="button" size="icon" className="ml-auto size-8 shrink-0 rounded-full">
                  <SendIcon className="size-3.5" />
                  <span className="sr-only">Send</span>
                </Button>
              </div>
            </div>
          </section>
        </div>
      </div>
    </main>
  );
}
