import { PlusIcon } from "lucide-react";
import {
  Suspense,
  useEffect,
  useRef,
  useState,
  type ComponentProps,
  type ComponentType,
} from "react";

import type {
  ComposerMobilePlusPanel as ComposerMobilePlusPanelType,
  ComposerPlusProps,
  Panel,
} from "./composer-mobile-plus-panel";
import { Button } from "@/components/ui/button";
import { COMPOSER_MENU_PANEL_CLASS } from "@/components/ui/composer-menu";
import { Dialog } from "@/components/ui/dialog";
import { MENU_NOTE_CLASS } from "@/components/ui/menu-styles";
import {
  ComposerMenuRowsSkeleton,
  lazyComposerPanel,
  preloadComposerMenuPanels,
} from "@/components/ui/composer-menu";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

export type { ComposerPlusProps } from "./composer-mobile-plus-panel";

type PanelProps = ComponentProps<typeof ComposerMobilePlusPanelType>;

/** The "+" menu itself: rendered at once when "+" opens after the preload. */
const LazyComposerPanel = lazyComposerPanel<PanelProps>(() =>
  import("./composer-mobile-plus-panel")
    .then((module) => module.ComposerMobilePlusPanel)
    .catch(() => ComposerPanelLoadFailed as ComponentType<PanelProps>),
);

/** The "+" menu and every drill-in body, loaded before the first open. */
function preloadComposerMenus() {
  preloadComposerMenuPanels();
}

function ComposerPanelNotice(props: ComposerPlusProps & { failed?: boolean }) {
  return (
    <DropdownMenuContent
      align="start"
      side={props.menuSide ?? (props.expandedPanelPresentation === "dialog" ? "bottom" : "top")}
      sideOffset={8}
      collisionPadding={12}
      className={COMPOSER_MENU_PANEL_CLASS}
    >
      {props.failed ? (
        <p role="alert" className={MENU_NOTE_CLASS}>
          Composer actions could not be loaded.
        </p>
      ) : (
        <ComposerMenuRowsSkeleton rows={4} label="Loading composer actions" />
      )}
      {props.failed ? (
        <Button type="button" size="sm" onClick={() => window.location.reload()}>
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
  // Warm the menus once the composer is idle, so "+" never opens onto a load.
  useEffect(() => {
    const idleWindow = window as Window & {
      requestIdleCallback?: (run: () => void) => number;
      cancelIdleCallback?: (handle: number) => void;
    };
    if (idleWindow.requestIdleCallback && idleWindow.cancelIdleCallback) {
      const handle = idleWindow.requestIdleCallback(preloadComposerMenus);
      return () => idleWindow.cancelIdleCallback?.(handle);
    }
    const handle = window.setTimeout(preloadComposerMenus, 1500);
    return () => window.clearTimeout(handle);
  }, []);
  const dialogOpen =
    open &&
    panel !== "root" &&
    panel !== "tools" &&
    panel !== "settings" &&
    panel !== "visibility" &&
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
            onPointerEnter={preloadComposerMenus}
            onFocus={preloadComposerMenus}
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
