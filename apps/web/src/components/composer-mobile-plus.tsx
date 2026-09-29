import { PlusIcon } from "lucide-react";
import { lazy, Suspense, useRef, useState } from "react";

import type { ComposerPlusProps, Panel } from "./composer-mobile-plus-panel";
import { Button } from "@/components/ui/button";
import { COMPOSER_MENU_PANEL_CLASS } from "@/components/ui/composer-menu";
import { Dialog } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type { ComposerPlusProps } from "./composer-mobile-plus-panel";

const LazyComposerPanel = lazy(() =>
  import("./composer-mobile-plus-panel")
    .then((module) => ({ default: module.ComposerMobilePlusPanel }))
    .catch(() => ({ default: ComposerPanelLoadFailed })),
);

function ComposerPanelNotice(props: ComposerPlusProps & { failed?: boolean }) {
  return (
    <DropdownMenuContent
      align="start"
      side={props.menuSide ?? (props.expandedPanelPresentation === "dialog" ? "bottom" : "top")}
      sideOffset={8}
      collisionPadding={12}
      className={COMPOSER_MENU_PANEL_CLASS}
    >
      <p role={props.failed ? "alert" : "status"} className="px-4 py-4 text-xs text-fg-muted">
        {props.failed ? "Composer actions could not be loaded." : "Loading actions…"}
      </p>
      {props.failed ? (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => window.location.reload()}
        >
          Reload
        </Button>
      ) : null}
    </DropdownMenuContent>
  );
}

function ComposerPanelLoadFailed(props: ComposerPlusProps) {
  return <ComposerPanelNotice {...props} failed />;
}

/** Keep the composer trigger/state eager; load its optional menu only when opened. */
export function ComposerMobilePlus(props: ComposerPlusProps) {
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [panel, setPanel] = useState<Panel>("root");
  const dialogOpen =
    open &&
    panel !== "root" &&
    panel !== "tools" &&
    panel !== "settings" &&
    props.expandedPanelPresentation === "dialog";

  return (
    <Dialog
      open={dialogOpen}
      onOpenChange={(next) => {
        if (!next) {
          setOpen(false);
          setPanel("root");
        }
      }}
    >
      <DropdownMenu
        open={open && !dialogOpen}
        onOpenChange={(next) => {
          if (dialogOpen) return;
          setOpen(next);
          if (!next) setPanel("root");
        }}
      >
        <DropdownMenuTrigger asChild>
          <Button
            ref={triggerRef}
            type="button"
            variant="ghost"
            size="icon-xs"
            disabled={props.disabled}
            aria-label="More composer actions"
            className="size-8 pointer-coarse:size-11 shrink-0 rounded-full text-fg-muted hover:text-fg"
          >
            <PlusIcon className="size-4" />
          </Button>
        </DropdownMenuTrigger>
        {open ? (
          <Suspense fallback={<ComposerPanelNotice {...props} />}>
            <LazyComposerPanel
              {...props}
              triggerRef={triggerRef}
              panel={panel}
              setPanel={setPanel}
              setOpen={setOpen}
              dialogOpen={dialogOpen}
            />
          </Suspense>
        ) : null}
      </DropdownMenu>
    </Dialog>
  );
}
