import {
  ActivityIcon,
  BoxesIcon,
  CloudIcon,
  EraserIcon,
  MessageSquareTextIcon,
  PaletteIcon,
  Table2Icon,
  type LucideIcon,
} from "lucide-react";
import type { ReactNode } from "react";

import { AppearanceMenu } from "@/components/appearance-menu";
import { BrandMark, Wordmark } from "@opengeni/react/app/components/brand-mark";
import { Button } from "@opengeni/react/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@opengeni/react/ui/dropdown-menu";

type Pitch = {
  headline: string;
  emphasis: string;
  lead: string;
  highlights: { icon: LucideIcon; text: string }[];
};

/** Which audience the panel beside the sign-in form speaks to. */
export type SignedOutPitch = "product" | "excel";

const pitches: Record<SignedOutPitch, Pitch> = {
  // Copy follows the public landing page (opengeni.ai): its headline, its lead
  // sentence and the platform features it names.
  product: {
    headline: "Agents in your product.",
    emphasis: "Infrastructure out of the box.",
    lead: "Build AI products without building the infrastructure from scratch.",
    highlights: [
      {
        icon: CloudIcon,
        text: "Durable sessions that keep working, even when you close your laptop",
      },
      { icon: BoxesIcon, text: "Tools and sandboxes, with approvals and permissions" },
      { icon: ActivityIcon, text: "Observability out of the box" },
    ],
  },
  // The sign-in window the Excel add-in opens: the person is working in a
  // workbook, so the panel says what the add-in does there, in plain words.
  excel: {
    headline: "Your Opengeni agents,",
    emphasis: "right inside Excel.",
    lead: "Sign in to connect the add-in. Then ask in plain words and watch the agent work in your open workbook.",
    highlights: [
      { icon: Table2Icon, text: "Builds tables, formulas and summaries in your sheets" },
      { icon: EraserIcon, text: "Cleans up messy data and formats sheets" },
      { icon: MessageSquareTextIcon, text: "Explains what is in a workbook" },
    ],
  },
};

/** Operator-configured legal documents; absent unless the deployment publishes them. */
export type SignedOutLegalLinks = {
  privacyPolicyUrl?: string | undefined;
  termsOfServiceUrl?: string | undefined;
};

/** Presentation only: the existing managed or broker panel owns authentication. */
export function SignedOutPage({
  children,
  legalLinks,
  pitch = "product",
  supportEmail,
}: {
  children: ReactNode;
  legalLinks?: SignedOutLegalLinks | undefined;
  /** Defaults to the product pitch; "excel" when the Excel add-in opened sign-in. */
  pitch?: SignedOutPitch | undefined;
  /** Operator support address, offered as a mailto link when configured. */
  supportEmail?: string | undefined;
}) {
  const { headline, emphasis, lead, highlights } = pitches[pitch];
  const legal = [
    { href: legalLinks?.privacyPolicyUrl, label: "Privacy", external: true },
    { href: legalLinks?.termsOfServiceUrl, label: "Terms", external: true },
    { href: supportEmail ? `mailto:${supportEmail}` : undefined, label: "Contact support" },
  ].filter((link): link is { href: string; label: string; external?: boolean } =>
    Boolean(link.href),
  );
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="og-page-glow flex min-h-full flex-col text-fg">
        <header className="mx-auto flex w-full max-w-[1040px] items-center justify-between gap-4 px-4 py-6 min-[721px]:px-10">
          <div className="flex items-center gap-2.5 text-fg">
            <BrandMark className="w-[31px]" />
            <Wordmark className="text-[23px]" />
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
        <div className="mx-auto flex w-full max-w-[1040px] flex-1 flex-col justify-center px-4 py-8 min-[721px]:px-10 min-[721px]:py-14">
          <div className="grid items-center gap-10 min-[721px]:grid-cols-[minmax(0,1fr)_minmax(0,390px)] min-[721px]:gap-16">
            <section aria-labelledby="signed-out-heading" className="min-w-0">
              <h1
                id="signed-out-heading"
                className="font-display text-[40px] leading-[1.08] font-medium tracking-[-1.5px] text-balance min-[721px]:text-[48px] min-[721px]:tracking-[-2px]"
              >
                {headline}{" "}
                <em className="font-serif text-[1.18em] leading-none font-normal">{emphasis}</em>
              </h1>
              <p className="mt-5 max-w-[330px] text-[15px] leading-[1.6] text-fg-muted">{lead}</p>
              <ul className="mt-8 space-y-4">
                {highlights.map(({ icon: Icon, text }) => (
                  <li key={text} className="flex items-start gap-3 text-sm text-fg">
                    <span className="mt-px flex size-6 shrink-0 items-center justify-center rounded-md border border-border bg-surface text-fg-muted">
                      <Icon className="size-3.5" aria-hidden="true" />
                    </span>
                    <span className="pt-0.5">{text}</span>
                  </li>
                ))}
              </ul>
            </section>
            <div className="w-full min-w-0 justify-self-center rounded-xl border border-border bg-surface p-[30px] min-[721px]:max-w-[390px] min-[721px]:justify-self-end forced-colors:border-[CanvasText] [&_button[type=submit]]:min-h-[42px]">
              {children}
            </div>
          </div>
        </div>
        <footer className="border-t border-border">
          <div className="mx-auto flex w-full max-w-[1040px] flex-wrap items-center justify-between gap-3 px-4 py-5 text-xs text-fg-subtle min-[721px]:px-10">
            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <Wordmark className="text-[15px] text-fg-muted" />
              {legal.length > 0 ? (
                <nav aria-label="Legal and support" className="flex items-center gap-4">
                  {legal.map((link) => (
                    <a
                      key={link.label}
                      href={link.href}
                      {...(link.external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
                      className="underline-offset-4 hover:text-fg hover:underline"
                    >
                      {link.label}
                    </a>
                  ))}
                </nav>
              ) : null}
            </div>
            <span>Your conversations. Your projects. One workspace.</span>
          </div>
        </footer>
      </div>
    </div>
  );
}
