import { useEffect, useState, type ReactNode } from "react";
import { MenuIcon } from "lucide-react";
import { Button } from "./button";
import { Sheet, SheetContent, SheetDescription, SheetTitle, SheetTrigger } from "./sheet";

/** Responsive navigation container; page selection stays with the caller. */
export function SettingsNavigation({
  title,
  open,
  onOpenChange,
  children,
}: {
  title: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: ReactNode;
}) {
  const [narrow, setNarrow] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 1024,
  );
  useEffect(() => {
    const media = window.matchMedia("(max-width: 1023px)");
    const update = () => setNarrow(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  const navigation = (
    <aside className="h-full min-h-0 overflow-y-auto overscroll-y-contain border-r border-border bg-surface/35 p-4">
      {children}
    </aside>
  );
  if (!narrow) return navigation;
  return (
    <header className="flex items-center justify-between border-b border-border px-4 py-2">
      <span className="text-sm font-medium">{title}</span>
      <Sheet open={open} onOpenChange={onOpenChange}>
        <SheetTrigger asChild>
          <Button variant="ghost" aria-label="Open settings navigation">
            <MenuIcon />
            Menu
          </Button>
        </SheetTrigger>
        <SheetContent side="left" className="w-[min(20rem,calc(100vw-2rem))] gap-0 bg-bg p-0">
          <SheetTitle className="sr-only">Settings navigation</SheetTitle>
          <SheetDescription className="sr-only">Choose a settings scope and page.</SheetDescription>
          {navigation}
        </SheetContent>
      </Sheet>
    </header>
  );
}
