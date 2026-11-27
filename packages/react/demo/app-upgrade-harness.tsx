// The app menu's real Upgrade from package dialog (UpgradeAppDialog) with a
// synthetic plan, to preview it. Upgrade only waits; nothing reaches an API.
//   ?plan=safe|destructive|conflict|other-app|update|restore   ?theme=light|dark
import type { AppPackageUpgradePlan } from "@opengeni/contracts";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { UpgradeAppDialog } from "@opengeni/react/app/components/artifacts/app-package";
import "./agent-settings.css";

const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";
const kind = params.get("plan") ?? "safe";

const safe: AppPackageUpgradePlan = {
  version: { changed: true, html: true, source: true, tools: true, assets: false },
  package: {
    id: "3f1c2b9a-8d4e-8f21-9a6b-5c7d0e1f2a3b",
    current: "3f1c2b9a-8d4e-8f21-9a6b-5c7d0e1f2a3b",
  },
  tools: { added: [{ serverId: "crm", toolName: "contacts_list" }], removed: [] },
  collections: { added: ["labels"], changed: [], unchanged: ["tasks"], kept: ["notes"] },
  migrations: { applied: ["create_items"], new: ["add_price"], conflicting: [] },
  queries: { added: ["count_items"], changed: ["list_items"], removed: [], unchanged: [] },
  syncs: { added: ["Import contacts"], changed: [], unchanged: [], kept: [] },
  destructive: [],
  conflicts: [],
  problems: [],
};
const update: AppPackageUpgradePlan = {
  ...safe,
  tools: { added: [], removed: [] },
  collections: { added: [], changed: ["entries"], unchanged: [], kept: [] },
  migrations: { applied: [], new: [], conflicting: [] },
  queries: { added: [], changed: [], removed: [], unchanged: [] },
  syncs: { added: [], changed: [], unchanged: [], kept: [] },
  packageVersion: { current: "1.0.0", next: "1.1.0" },
  skills: { added: [], changed: ["work-summary"], unchanged: [], kept: [] },
  automations: { added: [], kept: ["Update the work summary"] },
};
const plans: Record<string, AppPackageUpgradePlan> = {
  safe,
  update,
  restore: { ...update, packageVersion: { current: "1.1.0", next: "1.0.0" } },
  destructive: {
    ...safe,
    migrations: { applied: ["create_items"], new: ["add_price", "drop_qty"], conflicting: [] },
    destructive: [
      {
        part: "migration",
        name: "drop_qty",
        reason: "Its SQL could delete or overwrite existing rows (ALTER TABLE … DROP)",
      },
    ],
  },
  "other-app": {
    ...safe,
    package: {
      id: "9b2e4d6f-1a3c-8e5b-a7d9-0c2e4f6a8b1d",
      current: "3f1c2b9a-8d4e-8f21-9a6b-5c7d0e1f2a3b",
    },
    destructive: [
      {
        part: "package",
        reason: "This package is from a different app",
      },
    ],
  },
  conflict: {
    ...safe,
    migrations: { applied: [], new: ["add_price"], conflicting: ["create_items"] },
    conflicts: [
      {
        part: "migration",
        name: "create_items",
        reason:
          "The app already ran a migration with this name and different SQL. Migrations can't be changed once they ran; give the change a new migration name.",
      },
    ],
  },
};

function Preview() {
  useEffect(() => {
    document.documentElement.setAttribute("data-og-theme", dark ? "dark" : "light");
    document.documentElement.classList.toggle("dark", dark);
  }, []);
  return (
    <div className="og-root min-h-screen bg-og-bg text-og-fg">
      <UpgradeAppDialog
        state={
          {
            phase: "ready",
            source:
              kind === "update"
                ? { kind: "update", title: "Work summary", version: "1.1.0", request: {} }
                : kind === "restore"
                  ? { kind: "previous", title: "Work summary", version: "1.0.0", request: {} }
                  : { kind: "file", title: "Team board", request: { package: {} } },
            plan: plans[kind] ?? safe,
            key: "preview",
          } as never
        }
        onOpenChange={() => undefined}
        onUpgrade={() => new Promise(() => undefined)}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<Preview />);
