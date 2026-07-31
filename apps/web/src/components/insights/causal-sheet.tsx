import { AnimatePresence, motion } from "motion/react";
import { ArrowRightIcon, CheckCircle2Icon, CircleDotIcon } from "lucide-react";
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

import {
  CREDIT_DRIVERS,
  SESSION_TREE,
  WINDOW,
  formatTokens,
  formatUsd,
  type TraceTarget,
} from "./mock-data";

const STEPS = ["Window", "Driver", "Tree", "Receipt", "Act"] as const;

export function CausalSheet(props: {
  open: boolean;
  target: TraceTarget | null;
  onOpenChange: (open: boolean) => void;
}) {
  const [step, setStep] = useState(0);
  const driver = CREDIT_DRIVERS.find((d) => d.id === props.target?.driverId) ?? CREDIT_DRIVERS[0]!;

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
              Causal trace
            </SheetTitle>
            <SheetDescription className="text-xs leading-5 text-fg-muted">
              Decompose a credit-$ driver into session tree and usage_events receipts.
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
                <Block title="Window totals" body={`${WINDOW.label} · credit ledger only`}>
                  <dl className="grid grid-cols-2 gap-2 text-xs">
                    <Fact label="model.cost" value={formatUsd(WINDOW.modelCostUsd)} />
                    <Fact label="warm_cost" value={formatUsd(WINDOW.warmCostUsd)} />
                    <Fact label="model.tokens" value={formatTokens(WINDOW.tokens)} />
                    <Fact
                      label="Codex turns"
                      value={`${WINDOW.codexTurns} · $0 credit`}
                    />
                  </dl>
                </Block>
              ) : null}
              {step === 1 ? (
                <Block
                  title="Selected driver"
                  body={`Grouped by ${driver.groupBy} · sum(model.cost + warm_cost)`}
                >
                  <div className="rounded-lg border border-border bg-surface/50 p-3">
                    <p className="text-sm font-medium text-fg">{driver.label}</p>
                    <p className="mt-1 font-mono text-xs tabular-nums text-fg-muted">
                      {formatUsd(driver.creditUsd)} · {formatTokens(driver.tokens)} tokens ·{" "}
                      {driver.pctOfCreditUsd}% of window
                    </p>
                  </div>
                </Block>
              ) : null}
              {step === 2 ? (
                <Block
                  title="Session tree"
                  body="Root + children via session lineage; usage attributed by session_id."
                >
                  <ul className="grid gap-1.5">
                    {SESSION_TREE.map((node) => (
                      <li
                        key={node.id}
                        className="flex items-center gap-2 rounded-lg border border-border px-3 py-2"
                      >
                        <CircleDotIcon
                          className={cn(
                            "size-3.5 shrink-0",
                            node.role === "root" ? "text-brand" : "text-fg-subtle",
                          )}
                        />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-xs font-medium text-fg">
                            {node.role === "child" ? "└ " : ""}
                            {node.label}
                          </p>
                          <p className="truncate text-2xs text-fg-subtle">
                            {node.state} · {node.initiatorLabel}
                          </p>
                        </div>
                        <span className="font-mono text-2xs tabular-nums text-fg-muted">
                          {formatUsd(node.creditUsd)}
                        </span>
                      </li>
                    ))}
                  </ul>
                </Block>
              ) : null}
              {step === 3 ? (
                <Block
                  title="Example usage_events rows"
                  body="Idempotent meters on one turn attempt (illustrative)."
                >
                  <dl className="grid gap-2 rounded-lg border border-border bg-surface/40 p-3 text-xs">
                    {[
                      ["event_type", "model.tokens"],
                      ["quantity / unit", "842110 / tokens"],
                      ["event_type", "model.cost"],
                      ["quantity / unit", "2140000 / usd_micros"],
                      ["session_id / turn_id", "bound on row"],
                      ["origin", "goal"],
                      ["idempotency_key", "usage:model.*:turn:source"],
                    ].map(([k, v], i) => (
                      <div
                        key={`${k}-${i}`}
                        className="flex justify-between gap-3 border-b border-border/60 pb-1.5 last:border-0 last:pb-0"
                      >
                        <dt className="text-fg-subtle">{k}</dt>
                        <dd className="text-right font-mono text-fg-muted">{v}</dd>
                      </div>
                    ))}
                  </dl>
                </Block>
              ) : null}
              {step === 4 ? (
                <Block
                  title="Authority-correct actions"
                  body="Map findings to existing control APIs — not fleet restarts."
                >
                  <div className="grid gap-2">
                    {[
                      {
                        title: "Pause root goal",
                        detail: "PATCH goal status=paused — stops continuations / children.",
                        primary: true,
                      },
                      {
                        title: "Resolve approval",
                        detail: "Approve or reject the waiting tool call on the child turn.",
                        primary: false,
                      },
                      {
                        title: "Disable schedule",
                        detail: "If driver is a schedule — stop scheduled_task.fired volume.",
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
            <Button type="button" size="sm" variant="secondary" onClick={() => props.onOpenChange(false)}>
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
