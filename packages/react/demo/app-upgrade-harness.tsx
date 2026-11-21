// The app menu's real Upgrade from package dialog (UpgradeAppDialog) with a
// synthetic plan, to preview it. Upgrade only waits; nothing reaches an API.
//   ?plan=safe|destructive|conflict   ?theme=light|dark
import type { AppPackageUpgradePlan } from "@opengeni/contracts";
import { useEffect } from "react";
import { createRoot } from "react-dom/client";
import { UpgradeAppDialog } from "@opengeni/react/app/components/artifacts/app-package";
import "./agent-settings.css";

const params = new URLSearchParams(window.location.search);
const dark = params.get("theme") === "dark";
const kind = params.get("plan") ?? "safe";

const safe: AppPackageUpgradePlan = {
  version: { changed: true, html: true, source: true, tools: true },
  tools: { added: [{ serverId: "crm", toolName: "contacts_list" }], removed: [] },
  collections: { added: ["labels"], changed: [], unchanged: ["tasks"], kept: ["notes"] },
  migrations: { applied: ["create_items"], new: ["add_price"], conflicting: [] },
  queries: { added: ["count_items"], changed: ["list_items"], removed: [], unchanged: [] },
  syncs: { added: ["Import contacts"], changed: [], unchanged: [], kept: [] },
  destructive: [],
  conflicts: [],
  problems: [],
};
const plans: Record<string, AppPackageUpgradePlan> = {
  safe,
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
            chosen: { json: {}, title: "Team board", hasDemoData: false },
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
