import { AnimatePresence, motion } from "motion/react";
import { ArrowRightIcon, CheckCircle2Icon } from "lucide-react";
import { useState, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

import { formatTokens, formatUsd, type InsightsSnapshot, type TraceTarget } from "./mock-data";

const STEPS = ["Window", "Driver", "Act"] as const;

export function CausalSheet(props: {
  open: boolean;
  target: TraceTarget | null;
  onOpenChange: (open: boolean) => void;
  snapshot: InsightsSnapshot;
}) {
  const [step, setStep] = useState(0);
  const snap = props.snapshot;
  const modelCreditPrice = snap.models.reduce((n, m) => n + m.creditUsd, 0);
  const estimatedProviderUsd = snap.models.reduce((n, m) => n + m.estimatedProviderUsd, 0);
  const totalTokens = snap.models.reduce((n, m) => n + m.totalTokens, 0);
  const cachedTokens = snap.models.reduce((n, m) => n + m.cachedTokens, 0);
  const cacheInputTokens = snap.models.reduce((n, m) => n + m.cacheInputTokens, 0);
  const cachePct = cacheInputTokens > 0 ? Math.round((cachedTokens / cacheInputTokens) * 100) : 0;
  const driver =
    snap.drivers.find((d) => d.id === props.target?.driverId) ?? snap.drivers[0] ?? null;

  return (
    <Sheet
      open={props.open}
      onOpenChange={(open) => {
        if (open) setStep(0);
        props.onOpenChange(open);
      }}
    >
      <SheetContent
        side="right"
        className="flex h-full w-full flex-col gap-0 border-border bg-bg p-0 sm:max-w-md"
        showCloseButton
      >
        <div className="border-b border-border px-5 pb-4 pt-5">
          <SheetHeader className="gap-1 text-left">
            <SheetTitle className="text-base font-semibold tracking-[-0.02em]">
              Usage driver
            </SheetTitle>
            <SheetDescription className="text-xs leading-5 text-fg-muted">
              Token, cache, credit-price, and hypothetical provider-cost facts from model calls.
            </SheetDescription>
          </SheetHeader>
          <ol className="mt-4 flex gap-1">
            {STEPS.map((label, index) => {
              const active = index === step;
              const done = index < step;
              return (
                <li key={label} className="min-w-0 flex-1">
                  <button
                    type="button"
                    onClick={() => setStep(index)}
                    className={cn(
                      "flex w-full flex-col gap-1 text-left",
                      active ? "text-fg" : "text-fg-subtle hover:text-fg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "h-0.5 w-full rounded-full",
                        done || active ? "bg-brand" : "bg-surface-2",
                      )}
                    />
                    <span className="truncate text-2xs font-medium">{label}</span>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto px-5 py-5">
          <AnimatePresence mode="wait">
            <motion.div
              key={step}
              initial={{ opacity: 0, x: 12 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -8 }}
              transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
              className="grid gap-4"
            >
              {step === 0 ? (
                <Block title="Window totals" body={`${snap.rangeLabel} · UTC`}>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <Fact label="Total tokens" value={formatTokens(totalTokens)} />
                    <Fact label="cache hit" value={`${cachePct}%`} />
                    <Fact label="Estimated provider USD" value={formatUsd(estimatedProviderUsd)} />
                    <Fact label="Model credit price" value={formatUsd(modelCreditPrice)} />
                    <Fact
                      label="Workspace credit price"
                      value={formatUsd(snap.workspaceCreditUsd)}
                    />
                    <Fact label="warm hours" value={`${(snap.warmSeconds / 3600).toFixed(1)}h`} />
                  </dl>
                </Block>
              ) : null}
              {step === 1 ? (
                <Block
                  title="Selected driver"
                  body={
                    driver ? `Grouped by ${driver.groupBy}` : "No usage drivers in this window."
                  }
                >
                  {driver ? (
                    <div className="rounded-lg border border-border bg-surface/50 p-3">
                      <p className="text-sm font-medium text-fg">{driver.label}</p>
                      <p className="mt-1 font-mono text-xs tabular-nums text-fg-muted">
                        {formatTokens(driver.tokens)} tokens · {driver.pctOfTokens}% of shown
                        drivers · {driver.tokens === 0 ? "—" : `${driver.cacheHitPct}% cache`} ·{" "}
                        {driver.estimatedProviderCostKnownCalls > 0
                          ? `${formatUsd(driver.estimatedProviderUsd)} estimated provider USD`
                          : "provider price unknown"}
                        {" · "}
                        {formatUsd(driver.creditUsd)} OpenGeni credits
                      </p>
                    </div>
                  ) : (
                    <p className="text-xs text-fg-muted">Nothing to show yet.</p>
                  )}
                </Block>
              ) : null}
              {step === 2 ? (
                <Block title="Next moves" body="Use existing session, goal, and schedule controls.">
                  <div className="grid gap-2">
                    {[
                      {
                        title: "Open the root session",
                        detail: "Inspect the tree that owns this credit share.",
                        primary: true,
                      },
                      {
                        title: "Pause an active goal",
                        detail: "Stops goal continuations for that session.",
                        primary: false,
                      },
                      {
                        title: "Disable a schedule",
                        detail: "Cut fires when the driver is schedule-attributed.",
                        primary: false,
                      },
                    ].map((action) => (
                      <div
                        key={action.title}
                        className={cn(
                          "rounded-lg border px-3 py-2.5",
                          action.primary
                            ? "border-brand/40 bg-brand/5"
                            : "border-border bg-surface/40",
                        )}
                      >
                        <div className="flex items-start gap-2">
                          <CheckCircle2Icon
                            className={cn(
                              "mt-0.5 size-3.5 shrink-0",
                              action.primary ? "text-brand" : "text-fg-subtle",
                            )}
                          />
                          <div>
                            <p className="text-xs font-medium text-fg">{action.title}</p>
                            <p className="mt-0.5 text-2xs leading-4 text-fg-muted">
                              {action.detail}
                            </p>
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </Block>
              ) : null}
            </motion.div>
          </AnimatePresence>
        </div>

        <div className="flex items-center justify-between border-t border-border px-5 py-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={step === 0}
            onClick={() => setStep((s) => Math.max(0, s - 1))}
          >
            Back
          </Button>
          {step < STEPS.length - 1 ? (
            <Button type="button" size="sm" onClick={() => setStep((s) => s + 1)}>
              Continue
              <ArrowRightIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              onClick={() => props.onOpenChange(false)}
            >
              Done
            </Button>
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
}

function Block(props: { title: string; body: string; children: ReactNode }) {
  return (
    <div className="grid gap-3">
      <div>
        <h3 className="text-sm font-semibold text-fg">{props.title}</h3>
        <p className="mt-0.5 text-xs leading-5 text-fg-muted">{props.body}</p>
      </div>
      {props.children}
    </div>
  );
}

function Fact(props: { label: string; value: string }) {
  return (
    <div className="rounded-md border border-border bg-surface/40 px-2.5 py-2">
      <p className="text-2xs text-fg-subtle">{props.label}</p>
      <p className="mt-0.5 font-mono text-xs tabular-nums text-fg">{props.value}</p>
    </div>
  );
}
