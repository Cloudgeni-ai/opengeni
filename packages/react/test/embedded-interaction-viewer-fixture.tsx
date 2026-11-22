import { BrowserViewer, ComputerViewer } from "@opengeni/react/interaction";
import { OpenGeniBrowserClient } from "@opengeni/sdk/browser";
import { createRoot } from "react-dom/client";

const query = new URLSearchParams(location.search);
const props = {
  client: new OpenGeniBrowserClient({ baseUrl: `${location.origin}/api/opengeni` }),
  workspaceId: query.get("workspace")!,
  sessionId: query.get("session")!,
};

createRoot(document.getElementById("viewer")!).render(
  query.get("viewer") === "browser" ? (
    <BrowserViewer {...props} showAdvancedControls={false} />
  ) : (
    <ComputerViewer {...props} />
  ),
);
