import { ChevronRightIcon, CodeXmlIcon, MessageCircleIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useSimplifiedInterface } from "@opengeni/react/app/lib/simplified-interface";
import { LogoTile } from "@opengeni/react/ui/logo-tile";
import type { OnboardingUseCase } from "@opengeni/react/app/lib/onboarding-use-case";

/**
 * The two answers. They keep the stored use-case values: "Software engineer"
 * is `cloud` (then the guided setups), "Not an engineer" is `everyday` (then
 * the simplified interface). `embed` is the small link below them.
 */
const USE_CASES: Array<{
  id: Exclude<OnboardingUseCase, "embed">;
  title: string;
  description: string;
  icon: ReactNode;
}> = [
  {
    id: "cloud",
    title: "Software engineer",
    description: "Agents that review code, triage issues and watch your product.",
    icon: <CodeXmlIcon />,
  },
  {
    id: "everyday",
    title: "Not an engineer",
    description: "A simple chat for writing, research and everyday work.",
    icon: <MessageCircleIcon />,
  },
];

/**
 * The first post-signup question: one click picks the path, with no Continue.
 * The choice only shapes the steps after the organization.
 */
export function OnboardingUseCaseStep({
  onChoose,
}: {
  onChoose: (useCase: OnboardingUseCase) => void;
}) {
  const { simplified, productName } = useSimplifiedInterface();
  return (
    <section className="og-page-glow flex flex-1 items-center justify-center px-4 py-8">
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <h1 className="text-xl font-semibold tracking-tight">What do you do?</h1>
        <p className="mt-2 text-sm leading-relaxed text-fg-muted">
          We'll set up {productName} to fit. You can switch later.
        </p>
        <ul className="mt-6 grid gap-2" aria-label={`Ways to use ${productName}`}>
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
        {/* The simplified interface is for people using the product, not
            building on it, so it leaves out the developer path. */}
        {simplified ? null : (
          <p className="mt-5 mb-0 text-center text-xs text-fg-muted">
            <button
              type="button"
              onClick={() => onChoose("embed")}
              className="cursor-pointer rounded-sm underline-offset-2 outline-none hover:text-fg hover:underline focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              Adding agents to your own product?
            </button>
          </p>
        )}
      </div>
    </section>
  );
}
