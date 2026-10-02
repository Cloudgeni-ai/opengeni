import { useEffect, useRef, type ReactNode } from "react";

import { BrandMark, Wordmark } from "@/components/brand-mark";
import { cn } from "@/lib/utils";

/**
 * The frame every first-run step shares: the signed-out page's glow and
 * wordmark, the signed-in account on the right, and one centered column. It
 * scrolls as a page so a long step never clips on a phone.
 */
export function OnboardingFrame({
  account,
  children,
}: {
  /** Who is signed in, with a way out (OnboardingAccountHeader). */
  account?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="og-page-glow flex min-h-full flex-col text-fg">
        <header className="mx-auto flex w-full max-w-[1040px] items-center justify-between gap-x-4 px-4 pt-5 pb-2 min-[721px]:px-10">
          <div className="flex shrink-0 items-center gap-2 text-fg">
            <BrandMark className="w-[24px]" />
            <Wordmark className="text-[18px]" />
          </div>
          {account}
        </header>
        <div className="flex w-full flex-1 flex-col items-center justify-center px-4 pt-6 pb-16">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * One step: a card at the column width, with an optional progress line. Its
 * heading takes focus when the step changes, so a screen reader announces the
 * new step and keyboard users start at its top.
 */
export function OnboardingStep({
  stepKey,
  progress,
  title,
  description,
  width = "md",
  children,
  className,
}: {
  /** Changes when the step changes: refocuses the heading and replays the fade. */
  stepKey: string;
  progress?: { current: number; total: number } | null;
  title: ReactNode;
  description?: ReactNode;
  width?: "sm" | "md";
  children: ReactNode;
  className?: string;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRender = useRef(true);
  useEffect(() => {
    // The first step keeps the browser's own focus (an autofocused field).
    if (firstRender.current) {
      firstRender.current = false;
      return;
    }
    headingRef.current?.focus({ preventScroll: false });
  }, [stepKey]);
  return (
    <section
      key={stepKey}
      aria-labelledby={`onboarding-step-${stepKey}`}
      className={cn(
        "og-step-in w-full rounded-2xl border border-border bg-surface p-6 shadow-sm min-[480px]:p-8 forced-colors:border-[CanvasText]",
        width === "sm" ? "max-w-[420px]" : "max-w-[560px]",
        className,
      )}
    >
      {progress ? <OnboardingProgress {...progress} /> : null}
      <h1
        ref={headingRef}
        id={`onboarding-step-${stepKey}`}
        tabIndex={-1}
        className="text-xl leading-7 font-semibold tracking-[-0.5px] text-balance text-fg outline-none"
      >
        {title}
      </h1>
      {description ? (
        <p className="mt-1 text-sm leading-5 text-pretty text-fg-muted">{description}</p>
      ) : null}
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** "Step 2 of 3" with a segmented bar. Words carry the meaning; the bar repeats it. */
export function OnboardingProgress({ current, total }: { current: number; total: number }) {
  return (
    <div className="mb-5 flex items-center gap-3">
      <div aria-hidden="true" className="flex flex-1 gap-1">
        {Array.from({ length: total }, (_, index) => (
          <span
            key={index}
            className={cn(
              "h-1 flex-1 rounded-full transition-colors duration-[120ms]",
              index < current ? "bg-fg-muted" : "bg-border",
            )}
          />
        ))}
      </div>
      <p className="shrink-0 text-xs text-fg-muted">
        Step {current} of {total}
      </p>
    </div>
  );
}
