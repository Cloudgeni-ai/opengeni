import type { ConnectedModelListPrice, ConnectedModelListPricing } from "@opengeni/sdk";
import { CircleDollarSignIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useSharedQuery } from "@opengeni/react/app/lib/shared-query";
import { Button } from "@opengeni/react/ui/button";
import { Field, FieldStack, TextInput, useField } from "@opengeni/react/ui/field";
import { FormDialog } from "@opengeni/react/ui/form-dialog";
import { SegmentedControl } from "@opengeni/react/ui/segmented-control";
import { SelectMenu } from "@opengeni/react/ui/select-menu";

/* ----------------------------------------------------------------------------
   What an OpenAI model, Azure OpenAI deployment or OpenAI-compatible
   endpoint model costs, whether the organization or one workspace connected
   it. Their providers report no cost, so usage estimates, Insights and spend
   limits use this price: the list rate of the model it's served like (an
   Azure deployment's base model), or the administrator's own rate. Without
   one its usage is unpriced, never $0.
   -------------------------------------------------------------------------- */

/** The price fields a connected model carries, when its provider reports no cost. */
export interface PricedModelLike {
  id: string;
  upstreamModelId: string;
  version: number;
  listPrice?: ConnectedModelListPrice | null | undefined;
  listPriceKnown?: boolean | undefined;
}

const MICROS = 1_000_000;

/** "$2.5" for 2,500,000 micros. */
export function dollars(micros: number): string {
  return `$${Number((micros / MICROS).toFixed(4))}`;
}

/** USD typed as "2.50" or "$2.50" to micros, or null when it isn't a price. */
export function parseDollars(value: string): number | null {
  const trimmed = value.trim().replace(/^\$/u, "").trim();
  if (!/^\d+(\.\d+)?$/u.test(trimmed)) return null;
  const micros = Math.round(Number(trimmed) * MICROS);
  return Number.isSafeInteger(micros) && micros <= 1_000_000 * MICROS ? micros : null;
}

/**
 * The model's price on its row: priced like a model, at its own rate, at
 * its provider's list rate, or unpriced. Null when the model's provider
 * reports its own cost (nothing to show).
 */
export function listPriceSummary(model: PricedModelLike): string | null {
  if (model.listPriceKnown === undefined) return null;
  const price = model.listPrice;
  if (price?.basis === "model") return `Priced like ${price.modelId}`;
  if (price?.basis === "custom")
    return `Priced at ${dollars(price.pricing.inputMicrosPerMillionTokens)} input · ${dollars(price.pricing.outputMicrosPerMillionTokens)} output per 1M tokens`;
  return model.listPriceKnown
    ? "Priced at its list rate"
    : "No price yet, so spend limits can’t count its usage";
}

/** The catalogue model an id names exactly, or with an Azure `-YYYY-MM-DD` snapshot suffix. */
export function suggestedPriceBasis(
  upstreamModelId: string,
  ids: readonly string[],
): string | null {
  if (ids.includes(upstreamModelId)) return upstreamModelId;
  const snapshot = /^(.+)-\d{4}-\d{2}-\d{2}$/u.exec(upstreamModelId)?.[1];
  return snapshot && ids.includes(snapshot) ? snapshot : null;
}

type Basis = "model" | "custom";
const BASES = [
  { value: "model" as const, label: "Same as a model" },
  { value: "custom" as const, label: "Your own rate" },
];

function BasisControl({ value, onChange }: { value: Basis; onChange: (value: Basis) => void }) {
  const field = useField();
  return (
    <SegmentedControl
      options={BASES}
      value={value}
      onValueChange={onChange}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      className="max-w-full self-start"
    />
  );
}

function rateText(micros: number | undefined): string {
  return micros === undefined ? "" : String(Number((micros / MICROS).toFixed(4)));
}

/**
 * Set one model's price. `loadPriceBasisModelIds` reads the catalogue models
 * with a known list rate when the dialog first opens; `scope` and `cacheKey`
 * share that read between rows.
 */
export function ModelListPriceDialog({
  model,
  providerName,
  basisHint,
  scope,
  cacheKey,
  loadPriceBasisModelIds,
  onSave,
}: {
  model: PricedModelLike;
  /** "Azure OpenAI": who doesn't report the cost. */
  providerName: string;
  /** Under the model choice: "Choose the deployment's base model." */
  basisHint: string;
  scope: object;
  cacheKey: readonly string[];
  loadPriceBasisModelIds: () => Promise<string[]>;
  /** Resolves once saved; throws with a message to show when it isn't. */
  onSave: (listPrice: ConnectedModelListPrice | null) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const ids = useSharedQuery(scope, [...cacheKey, "price-basis-models"], loadPriceBasisModelIds, {
    enabled: open,
    staleTimeMs: 10 * 60_000,
  });
  const options = ids.data ?? [];
  const current = model.listPrice ?? null;
  const [basis, setBasis] = useState<Basis>(current?.basis ?? "model");
  const [modelId, setModelId] = useState<string | null>(
    current?.basis === "model" ? current.modelId : null,
  );
  const [input, setInput] = useState("");
  const [cached, setCached] = useState("");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [clearing, setClearing] = useState(false);
  useEffect(() => {
    if (!open) return;
    const pricing = current?.basis === "custom" ? current.pricing : undefined;
    setBasis(current?.basis ?? "model");
    setModelId(current?.basis === "model" ? current.modelId : null);
    setInput(rateText(pricing?.inputMicrosPerMillionTokens));
    setCached(rateText(pricing?.cachedInputMicrosPerMillionTokens));
    setOutput(rateText(pricing?.outputMicrosPerMillionTokens));
    setError(null);
    // oxlint-disable-next-line react-hooks/exhaustive-deps -- reset to the saved price on open
  }, [open]);
  // Until something is chosen, offer the model the name already matches.
  const chosenModel = modelId ?? suggestedPriceBasis(model.upstreamModelId, options);
  const inputMicros = parseDollars(input);
  const outputMicros = parseDollars(output);
  const cachedMicros = cached.trim() ? parseDollars(cached) : undefined;
  const rateError = (value: string, micros: number | null | undefined) =>
    value.trim() && micros === null ? "Enter a price in US dollars, such as 2.50." : undefined;
  const customPricing: ConnectedModelListPricing | null =
    inputMicros !== null && outputMicros !== null && cachedMicros !== null
      ? {
          inputMicrosPerMillionTokens: inputMicros,
          outputMicrosPerMillionTokens: outputMicros,
          ...(cachedMicros === undefined
            ? {}
            : { cachedInputMicrosPerMillionTokens: cachedMicros }),
        }
      : null;
  const next: ConnectedModelListPrice | null =
    basis === "model"
      ? chosenModel
        ? { basis: "model", modelId: chosenModel }
        : null
      : customPricing
        ? { basis: "custom", pricing: customPricing }
        : null;
  return (
    <FormDialog
      open={open}
      onOpenChange={setOpen}
      size="sm"
      trigger={
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          className="rounded-[10px] text-fg-subtle hover:text-fg pointer-coarse:size-11"
          aria-label={`Price for ${model.upstreamModelId}`}
          title="Price"
        >
          <CircleDollarSignIcon aria-hidden="true" />
        </Button>
      }
      title="Price"
      description={
        <>
          What a call to <span className="break-all font-mono">{model.upstreamModelId}</span> costs,
          for usage estimates and spend limits. {providerName} doesn’t report its cost, so without a
          price its usage isn’t counted. Nothing is charged.
        </>
      }
      submitLabel="Save price"
      pendingLabel="Saving…"
      submitDisabled={next === null}
      error={error}
      footerStart={
        current ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={clearing}
            onClick={async () => {
              setClearing(true);
              setError(null);
              try {
                if (await onSave(null)) setOpen(false);
              } catch (failure) {
                setError(failure instanceof Error ? failure.message : String(failure));
              } finally {
                setClearing(false);
              }
            }}
          >
            {clearing ? "Removing…" : "Remove price"}
          </Button>
        ) : null
      }
      onSubmit={async () => (next ? await onSave(next) : false)}
      onSubmitted={() => setOpen(false)}
    >
      <FieldStack>
        <Field label="Price it">
          <BasisControl value={basis} onChange={setBasis} />
        </Field>
        {basis === "model" ? (
          <Field label="Model" hint={`${basisHint} Its list rate prices every call.`}>
            <SelectMenu
              variant="combobox"
              options={options.map((id) => ({ value: id, label: id }))}
              value={chosenModel}
              onValueChange={setModelId}
              placeholder="Choose a model"
              searchPlaceholder="Search models"
              loading={ids.loading && options.length === 0}
              loadingLabel="Loading models…"
              emptyMessage={ids.error ? "Couldn’t load models. Close and try again." : "No models"}
            />
          </Field>
        ) : (
          <>
            <Field
              label="Input, per 1M tokens"
              error={rateError(input, inputMicros)}
              hint="In US dollars."
            >
              <TextInput
                inputMode="decimal"
                value={input}
                onChange={(event) => setInput(event.target.value)}
                placeholder="2.50"
                autoComplete="off"
              />
            </Field>
            <Field
              label="Cached input, per 1M tokens"
              optional
              error={rateError(cached, cachedMicros)}
              hint="Without one, cached input costs the same as input."
            >
              <TextInput
                inputMode="decimal"
                value={cached}
                onChange={(event) => setCached(event.target.value)}
                placeholder="0.25"
                autoComplete="off"
              />
            </Field>
            <Field label="Output, per 1M tokens" error={rateError(output, outputMicros)}>
              <TextInput
                inputMode="decimal"
                value={output}
                onChange={(event) => setOutput(event.target.value)}
                placeholder="10.00"
                autoComplete="off"
              />
            </Field>
          </>
        )}
      </FieldStack>
    </FormDialog>
  );
}
