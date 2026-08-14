import { OpenAIResponsesModel, type AgentInputItem, type ModelRequest } from "@openai/agents";
import OpenAI from "openai";

import { recordModelPreparationMeasurement } from "./model-preparation-diagnostics";

/**
 * Responses model optimized for immutable, normally append-only protocol input.
 *
 * The upstream converter is pure but otherwise rebuilds every nested wire item
 * before every model call. This class proves an unchanged prefix by object
 * identity, reuses its already-converted wire items, and converts only the new
 * or divergent tail. It changes neither item order nor serialization.
 *
 * Source items must not be mutated in place after a request. That is already
 * the contract of Agents SDK external history ownership; replacing an item or
 * array is safe and detected here.
 */
export class AppendOnlyOpenAIResponsesModel extends OpenAIResponsesModel {
  private previousProtocolInput: AgentInputItem[] | null = null;
  private previousProtocolInputLength = 0;
  private previousResponsesInput: OpenAI.Responses.ResponseInputItem[] | null = null;

  protected override _getInputItems(
    input: ModelRequest["input"],
  ): OpenAI.Responses.ResponseInputItem[] {
    const startedAt = performance.now();
    let outcome: "completed" | "failed" = "completed";
    try {
      if (typeof input === "string") {
        this.clearConvertedInput();
        return super._getInputItems(input);
      }

      const previousProtocolInput = this.previousProtocolInput;
      const previousResponsesInput = this.previousResponsesInput;
      let commonPrefixLength = 0;
      if (previousProtocolInput && previousResponsesInput) {
        const comparableLength = Math.min(
          this.previousProtocolInputLength,
          previousResponsesInput.length,
          input.length,
        );
        while (
          commonPrefixLength < comparableLength &&
          previousProtocolInput[commonPrefixLength] === input[commonPrefixLength]
        ) {
          commonPrefixLength += 1;
        }
      }

      let converted: OpenAI.Responses.ResponseInputItem[];
      if (
        previousResponsesInput &&
        commonPrefixLength === input.length &&
        input.length === this.previousProtocolInputLength
      ) {
        converted = previousResponsesInput;
      } else if (previousResponsesInput && commonPrefixLength > 0) {
        converted = [
          ...previousResponsesInput.slice(0, commonPrefixLength),
          ...super._getInputItems(input.slice(commonPrefixLength)),
        ];
      } else {
        converted = super._getInputItems(input);
      }

      // Retain the exact immutable source array and its then-current length. If a
      // caller appends to the same array, the captured length prevents treating
      // unconverted items as cached; replacement/divergence is identity-checked.
      this.previousProtocolInput = input;
      this.previousProtocolInputLength = input.length;
      this.previousResponsesInput = converted;
      return converted;
    } catch (error) {
      outcome = "failed";
      throw error;
    } finally {
      recordModelPreparationMeasurement({
        phase: "responses_input_conversion",
        outcome,
        durationSeconds: (performance.now() - startedAt) / 1_000,
        count: typeof input === "string" ? 1 : input.length,
      });
    }
  }

  private clearConvertedInput(): void {
    this.previousProtocolInput = null;
    this.previousProtocolInputLength = 0;
    this.previousResponsesInput = null;
  }
}
