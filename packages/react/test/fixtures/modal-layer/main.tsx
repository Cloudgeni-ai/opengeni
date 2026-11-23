import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import { LightboxProvider, useLightboxOptional } from "../../../src/timeline/screenshot-lightbox";
import { Button } from "../../../src/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
  DialogTrigger,
} from "../../../src/ui/dialog";
import { PortalContainerProvider } from "../../../src/ui/portal-container";
import "../../../styles/compiled.css";

const params = new URLSearchParams(location.search);
document.documentElement.dataset.ogTheme = params.get("theme") ?? "light";

function ExampleDialog({ modal = true }: { modal?: boolean }) {
  const [confirmed, setConfirmed] = useState(false);
  return (
    <Dialog modal={modal}>
      <DialogTrigger asChild>
        <Button>Open dialog</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogTitle>Share this project</DialogTitle>
        <DialogDescription>Copy a link to share it with your team.</DialogDescription>
        <Button onClick={() => setConfirmed(true)}>{confirmed ? "Link copied" : "Copy link"}</Button>
      </DialogContent>
    </Dialog>
  );
}

function LightboxTrigger() {
  const lightbox = useLightboxOptional();
  return (
    <Button
      onClick={(event) =>
        lightbox?.open(
          `data:image/svg+xml,${encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="720" height="450"><path fill="#4c7ec2" d="M0 0h720v450H0z"/><circle fill="#e5e8dc" cx="360" cy="225" r="125"/></svg>')}`,
          "Project preview",
          event.currentTarget,
          "Screenshot preview",
        )
      }
    >
      Open screenshot
    </Button>
  );
}

function App() {
  const [portal, setPortal] = useState<HTMLDivElement | null>(null);
  return (
    <main style={{ minHeight: "125vh", padding: 32 }}>
      <h1 className="mb-4 text-xl font-semibold">Project overview</h1>
      <div className="flex gap-2">
        <PortalContainerProvider container={params.has("contained") ? portal : null}>
          <ExampleDialog modal={!params.has("nonmodal")} />
          <LightboxProvider><LightboxTrigger /></LightboxProvider>
        </PortalContainerProvider>
      </div>
      <div ref={setPortal} id="contained-portal" />
    </main>
  );
}

createRoot(document.querySelector("#app")!).render(<App />);
