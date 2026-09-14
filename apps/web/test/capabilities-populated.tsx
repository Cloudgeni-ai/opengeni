import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { BookOpenIcon, BoxesIcon, PlusIcon, SearchIcon } from "lucide-react";
import {
  ConnectionInstalled,
  ConnectionCatalog,
  ConnectionLogo,
  CapabilityCatalogRow,
} from "@opengeni/react/connect";
import { CatalogHeader, CatalogActionContext } from "../src/components/capabilities/catalog-header";
import { Button } from "../src/components/ui/button";
import { Input } from "../src/components/ui/input";
import { Dialog, DialogTitle, DialogDescription } from "../src/components/ui/dialog";
import { CapabilityDialogContent } from "../src/components/capabilities/detail-dialog";
import "@opengeni/react/connect.css";
import "../src/styles.css";

// Development-only visual fixture. Uses production catalog components; no API writes or credentials.
const samples = {
  Connections: [
    [
      "Slack · OpenGeni bot",
      "Mention @OpenGeni or chat with the bot in Slack.",
      "https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_256.png",
    ],
    [
      "Slack · Your account",
      "Let OpenGeni read and send Slack messages as you.",
      "https://a.slack-edge.com/80588/marketing/img/meta/slack_hash_256.png",
    ],
    [
      "GitHub",
      "Repositories, issues, and pull requests.",
      "https://github.githubassets.com/favicons/favicon.svg",
    ],
    [
      "Notion",
      "Search pages, notes, and shared project knowledge.",
      "https://www.notion.so/images/favicon.ico",
    ],
    [
      "PostHog",
      "Product analytics, feature flags, and session insights.",
      "https://posthog.com/favicon.ico",
    ],
    ["Linear", "Plan projects and track issues with your team.", "https://linear.app/favicon.ico"],
    [
      "Figma",
      "Read designs, components, and comments.",
      "https://static.figma.com/app/icon/1/favicon.svg",
    ],
  ],
  Skills: [
    ["Review pull requests", "Check correctness, regressions, and missing test coverage."],
    ["Write release notes", "Turn shipped changes into clear customer updates."],
    ["Research a topic", "Compare sources and summarize the evidence."],
    ["Prepare a meeting", "Collect context and draft a focused agenda."],
    ["Improve accessibility", "Review keyboard navigation, labels, and contrast."],
    ["Analyze feedback", "Group customer feedback into actionable themes."],
    ["Create a project brief", "Define the problem, scope, and success criteria."],
    ["Review documentation", "Find gaps and keep examples accurate."],
  ],
  Plugins: [
    ["Research", "Search sources and prepare evidence-backed reports."],
    ["Design", "Review interfaces and work with design files."],
    ["Engineering", "Inspect repositories and support development workflows."],
    ["Productivity", "Prepare meetings, organize notes, and plan your work."],
    ["Customer support", "Summarize conversations and draft useful replies."],
    ["Analytics", "Explore product metrics and investigate trends."],
  ],
};
type Category = keyof typeof samples;
type Tab = "All" | Category;
function Fixture() {
  const [tab, setTab] = useState<Tab>("All");
  const [target, setTarget] = useState<HTMLDivElement | null>(null);
  const toolbar = useMemo(() => ({ target, activeTitle: tab }), [target, tab]);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string | null>(null);
  const rows = samples[tab === "All" ? "Connections" : tab].filter((row) =>
    row.join(" ").toLowerCase().includes(query.toLowerCase()),
  );
  const installedCount = tab === "Skills" ? 5 : 4;
  const added = new Set(
    samples[tab === "All" ? "Connections" : tab].slice(0, installedCount).map((row) => row[0]),
  );
  const icon = (row: string[], strip = false) =>
    tab === "Skills" ? (
      <BookOpenIcon
        aria-hidden="true"
        className={strip ? "size-10 p-2 text-fg-muted" : "text-fg-muted"}
      />
    ) : (
      <ConnectionLogo
        src={row[2] ?? null}
        name={row[0]!}
        size={40}
        fallback={tab === "Plugins" ? <BoxesIcon aria-hidden="true" /> : undefined}
      />
    );
  return (
    <CatalogActionContext.Provider value={toolbar}>
      <main className="mx-auto max-w-6xl px-6 py-10 text-fg">
        <div className="mb-8 flex flex-wrap items-center justify-between gap-3 text-sm text-fg-muted">
          <p>Local sample view · example data, no accounts connected</p>
          <a className="underline underline-offset-4" href="/">
            Back to your workspace
          </a>
        </div>
        <h1 className="mb-6 text-2xl font-semibold">Capabilities</h1>
        <div className="relative mb-6">
          <SearchIcon aria-hidden="true" className="absolute left-4 top-3 size-4 text-fg-muted" />
          <Input
            className="h-10 pl-11"
            aria-label={
              tab === "All"
                ? "Search connections, skills, and plugins"
                : `Search ${tab.toLowerCase()}`
            }
            placeholder={
              tab === "All"
                ? "Search connections, skills, and plugins"
                : `Search ${tab.toLowerCase()}`
            }
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <div className="capabilities-tab-bar">
          <div role="tablist" aria-label="Capabilities" className="flex gap-7">
            {(["All", ...Object.keys(samples)] as Tab[]).map((name) => (
              <button
                key={name}
                id={`tab-${name}`}
                role="tab"
                aria-selected={tab === name}
                aria-controls={`panel-${name}`}
                onClick={() => setTab(name)}
                style={{ borderBottomColor: tab === name ? "var(--color-fg)" : "transparent" }}
                className={`border-b-2 pb-3 text-sm ${tab === name ? "text-fg" : "text-fg-muted"}`}
              >
                {name}
              </button>
            ))}
          </div>
          <div ref={setTarget} className="capabilities-tab-action" />
        </div>
        {tab === "All" ? (
          <section role="tabpanel" aria-labelledby="tab-All">
            {(Object.keys(samples) as Category[]).map((category) => {
              const matches = samples[category].filter((row) =>
                row.join(" ").toLowerCase().includes(query.toLowerCase()),
              );
              return (
                <section key={category} className="mt-6" aria-label={category}>
                  <h2 className="mb-3 text-sm font-semibold">{category}</h2>
                  <div className="og-capability-catalog-grid">
                    {matches.slice(0, 6).map((row, index) => (
                      <CapabilityCatalogRow
                        key={row[0]}
                        name={row[0]!}
                        description={row[1]}
                        icon={
                          category === "Skills" ? (
                            <BookOpenIcon />
                          ) : (
                            <ConnectionLogo src={row[2] ?? null} name={row[0]!} />
                          )
                        }
                        status={index < (category === "Skills" ? 5 : 4) ? "added" : "available"}
                        onOpen={() => setSelected(row[0]!)}
                      />
                    ))}
                  </div>
                  {matches.length > 6 ? (
                    <Button variant="ghost" onClick={() => setTab(category)}>
                      View all {category.toLowerCase()}
                    </Button>
                  ) : null}
                </section>
              );
            })}
          </section>
        ) : (
          <section id={`panel-${tab}`} role="tabpanel" aria-labelledby={`tab-${tab}`}>
            <CatalogHeader
              title={tab}
              action={
                <Button
                  onClick={() =>
                    setSelected(
                      tab === "Connections"
                        ? "Add connection"
                        : tab === "Skills"
                          ? "New skill"
                          : "Import plugin",
                    )
                  }
                >
                  <PlusIcon />
                  {tab === "Connections"
                    ? "Add connection"
                    : tab === "Skills"
                      ? "New skill"
                      : "Import plugin"}
                </Button>
              }
            />
            <ConnectionInstalled
              title={
                tab === "Connections" ? "Connected" : tab === "Skills" ? "Your skills" : "Installed"
              }
              items={rows
                .filter((row) => added.has(row[0]))
                .map((row) => ({
                  id: row[0]!,
                  name: row[0]!,
                  status: "Sample",
                  icon: icon(row, true),
                  onOpen: () => setSelected(row[0]!),
                }))}
            />
            <section className={tab === "Plugins" ? "og-plugin-discovery" : "og-skill-discovery"}>
              <header>
                <h3>{tab === "Connections" ? "Featured" : `Browse ${tab.toLowerCase()}`}</h3>
              </header>
              {tab === "Connections" ? (
                <ConnectionCatalog
                  columns={2}
                  grouped={false}
                  services={rows.map((row) => ({
                    id: row[0]!,
                    name: row[0]!,
                    logo: icon(row),
                    options: [
                      {
                        id: row[0]!,
                        name: row[0]!,
                        description: row[1]!,
                        status: added.has(row[0]) ? "Connected" : "Available",
                        connected: added.has(row[0]),
                        state: added.has(row[0]) ? "added" : "available",
                        onOpen: () => setSelected(row[0]!),
                      },
                    ],
                  }))}
                />
              ) : (
                <div className="og-capability-catalog-grid">
                  {rows.map((row) => (
                    <CapabilityCatalogRow
                      key={row[0]}
                      name={row[0]!}
                      description={row[1]}
                      icon={icon(row)}
                      status={added.has(row[0]) ? "added" : "available"}
                      onOpen={() => setSelected(row[0]!)}
                    />
                  ))}
                </div>
              )}
            </section>
          </section>
        )}
        <Dialog
          open={selected !== null}
          onOpenChange={(open) => {
            if (!open) setSelected(null);
          }}
        >
          <CapabilityDialogContent className="p-6">
            <DialogTitle>{selected}</DialogTitle>
            <DialogDescription>
              This is a local layout sample. Return to your workspace to install a skill or plugin,
              or authorize a connection.
            </DialogDescription>
            <Button onClick={() => setSelected(null)}>Done</Button>
          </CapabilityDialogContent>
        </Dialog>
      </main>
    </CatalogActionContext.Provider>
  );
}
if (import.meta.env.DEV) createRoot(document.getElementById("root")!).render(<Fixture />);
