import { CalendarClockIcon, CloudIcon, PaletteIcon, SlidersHorizontalIcon } from "lucide-react";
import type { ReactNode } from "react";

import { AppearanceMenu } from "@/components/appearance-menu";
import { BrandMark } from "@/components/brand-mark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const highlights = [
  { icon: SlidersHorizontalIcon, text: "Choose your models and tools" },
  { icon: CalendarClockIcon, text: "Schedule one-off or recurring tasks" },
  { icon: CloudIcon, text: "Your agents keep working, even when you close your laptop" },
];

/** Presentation only: the existing managed or broker panel owns authentication. */
export function SignedOutPage({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="flex min-h-full flex-col bg-bg text-fg">
        <header className="mx-auto flex w-full max-w-6xl items-center justify-between gap-4 px-6 py-6 sm:px-10">
          <div className="flex items-center gap-3">
            <BrandMark className="size-9 text-brand" />
            <span className="text-lg font-semibold tracking-tight">OpenGeni</span>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="ghost" size="sm">
                <PaletteIcon className="size-4" aria-hidden="true" />
                Appearance
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <AppearanceMenu />
            </DropdownMenuContent>
          </DropdownMenu>
        </header>
        <div className="mx-auto flex w-full max-w-6xl flex-1 flex-col justify-center px-6 py-8 sm:px-10 sm:py-14">
          <div className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-20">
            <section aria-labelledby="signed-out-heading" className="min-w-0">
              <p className="mb-4 text-xs font-medium tracking-widest text-brand uppercase">
                Your AI workspace
              </p>
              <h1
                id="signed-out-heading"
                className="text-4xl font-semibold tracking-tight text-balance sm:text-5xl"
              >
                Open-source cloud agents
              </h1>
              <p className="mt-5 max-w-lg text-base leading-relaxed text-fg-muted">
                Work on research, documents, and code. Keep the conversation, context, and results
                together.
              </p>
              <ul className="mt-9 space-y-6">
                {highlights.map(({ icon: Icon, text }) => (
                  <li key={text} className="flex items-start gap-3 text-sm font-medium">
                    <Icon className="mt-0.5 size-5 shrink-0 text-brand" aria-hidden="true" />
                    <span>{text}</span>
                  </li>
                ))}
              </ul>
            </section>
            <div className="min-w-0 rounded-lg border border-border bg-surface p-5 shadow-sm sm:p-7 forced-colors:border-[CanvasText]">
              {children}
            </div>
          </div>
        </div>
        <footer className="mx-auto flex w-full max-w-6xl flex-wrap justify-between gap-3 px-6 py-6 text-xs text-fg-subtle sm:px-10">
          <span>OpenGeni</span>
          <span>Your conversations. Your projects. One workspace.</span>
        </footer>
      </div>
    </div>
  );
}
