import { ChevronRightIcon, CloudIcon, CodeXmlIcon } from "lucide-react";
import type { ReactNode } from "react";

import { LogoTile } from "@/components/ui/logo-tile";
import type { OnboardingUseCase } from "@/lib/onboarding-use-case";

const USE_CASES: Array<{
  id: OnboardingUseCase;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "embed",
    title: "Add AI agents to my product",
    description: "Put Opengeni agents in your app. We'll get your API key ready and help build it.",
    icon: <CodeXmlIcon />,
  },
  {
    id: "cloud",
    title: "Run agents in the cloud",
    description: "Give agents real work. They run on their own computer while you do other things.",
    icon: <CloudIcon />,
  },
];

/**
 * The first post-signup question: one click picks the path, with no Continue.
 * Both rows lead on; the choice only shapes the steps after the organization.
 */
export function OnboardingUseCaseStep({
  onChoose,
}: {
  onChoose: (useCase: OnboardingUseCase) => void;
}) {
  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">How do you want to use Opengeni?</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          Pick one to get started. You can do both later.
        </p>
        <ul className="mt-6 grid gap-2" aria-label="Ways to use Opengeni">
          {USE_CASES.map((useCase) => (
            <li key={useCase.id}>
              <button
                type="button"
                onClick={() => onChoose(useCase.id)}
                className="flex min-h-[76px] w-full cursor-pointer items-center gap-4 rounded-[14px] border border-border bg-surface px-4 py-3 text-left transition-colors outline-none hover:border-border-strong hover:bg-hover focus-visible:ring-2 focus-visible:ring-ring/40 focus-visible:ring-offset-2 focus-visible:ring-offset-bg"
              >
                <LogoTile icon={useCase.icon} tone="brand" />
                <span className="grid min-w-0 flex-1 gap-1">
                  <span className="text-sm font-medium text-fg">{useCase.title}</span>
                  <span className="text-xs leading-[18px] text-fg-muted">
                    {useCase.description}
                  </span>
                </span>
                <ChevronRightIcon aria-hidden="true" className="size-4 shrink-0 text-fg-subtle" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}
