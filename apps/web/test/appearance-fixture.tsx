import { createRoot } from "react-dom/client";
import { PersonalWorkspaceBadge } from "../src/components/personal-workspace-badge";
import { AppearanceProvider } from "../src/lib/appearance";
import { AppearanceMenu } from "../src/components/appearance-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "../src/components/ui/dropdown-menu";
import { Toaster } from "../src/components/ui/sonner";
import { toast } from "sonner";
import "../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <AppearanceProvider>
    <main className="flex h-screen bg-background text-foreground">
      <aside className="flex w-64 flex-col border-r bg-surface p-2">
        <div className="p-3 text-sm font-medium">OpenGeni</div>
        <div className="mt-auto">
          <DropdownMenu>
            <DropdownMenuTrigger className="min-h-11 w-full rounded-md p-2 text-left text-sm hover:bg-surface-2">
              Example user
            </DropdownMenuTrigger>
            <DropdownMenuContent
              side="top"
              align="start"
              className="w-[min(18rem,calc(100vw-1rem))]"
            >
              <DropdownMenuLabel>
                Example user
                <span className="block text-xs font-normal text-fg-subtle">user@example.test</span>
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <AppearanceMenu />
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </aside>
      <section className="flex-1 p-8">
        <h1 className="text-xl font-medium">Your workspace</h1>
        <div className="mt-4 rounded-md bg-surface-3 p-3">
          <PersonalWorkspaceBadge />
        </div>
        <p className="mt-2 text-sm text-fg-muted">A comfortable space for your next idea.</p>
        <button
          className="mt-6 rounded-md bg-surface-2 px-4 py-2 text-sm"
          onClick={() => toast.success("Appearance updated")}
        >
          Show notification
        </button>
      </section>
    </main>
    <Toaster />
  </AppearanceProvider>,
);
