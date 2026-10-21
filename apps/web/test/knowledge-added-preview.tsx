import { useState } from "react";
import { createRoot } from "react-dom/client";
import { BrainCircuitIcon, PlusIcon } from "lucide-react";
import { LibraryTab, initialLibraryView } from "../src/components/knowledge/knowledge-library";
import { Button } from "@opengeni/react/ui/button";
import { ContentPage } from "@opengeni/react/ui/content-layout";
import { PageHeader } from "@opengeni/react/ui/page-header";
import {
  LineTabs,
  LineTabsContent,
  LineTabsList,
  LineTabsTrigger,
} from "@opengeni/react/ui/line-tabs";
import "../src/styles.css";

function Preview() {
  const [view, setView] = useState(initialLibraryView(false));
  return (
    <main data-canvas className="flex min-h-screen bg-canvas text-fg">
      <ContentPage width="standard">
        <LineTabs value="library">
          <PageHeader
            title="Knowledge"
            icon={<BrainCircuitIcon />}
            description="Sample data · real Library components"
            actions={
              <Button>
                <PlusIcon />
                Add knowledge
              </Button>
            }
            tabs={
              <LineTabsList>
                <LineTabsTrigger value="library">Library</LineTabsTrigger>
              </LineTabsList>
            }
          />
          <LineTabsContent value="library">
            <LibraryTab
              workspaceId="preview"
              view={view}
              onViewChange={setView}
              refresh={0}
              onClearFile={() => undefined}
              canAdd
              canUpload
              onAdd={() => undefined}
              onUpload={() => undefined}
              actions={{
                canEdit: () => false,
                onOpen: () => undefined,
                onArchive: () => undefined,
                onRestore: () => undefined,
                linkFor: (entry) => `/?entry=${entry.id}`,
              }}
            />
          </LineTabsContent>
        </LineTabs>
      </ContentPage>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Preview />);
