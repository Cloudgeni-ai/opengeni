import {
  CompanyBrainGovernedWriteAttempt,
  CompanyBrainGovernedWriteReceipt,
  CompanyBrainGovernedWriteRequest,
  type CompanyBrainGovernedWriteReceipt as CompanyBrainGovernedWriteReceiptType,
} from "@opengeni/contracts";
import { type Database, writeCompanyBrainGovernedProposal } from "@opengeni/db";

export type CompanyBrainGovernedWriteInput = {
  attempt: unknown;
  request: unknown;
};

export type CompanyBrainGovernedWriteRouterOptions = {
  db: Database;
  authority?: typeof writeCompanyBrainGovernedProposal;
};

/**
 * Transport-neutral facade for explicit governed Company Brain proposals.
 * It intentionally exposes no generic remember call, selector, activation,
 * rollback token, or personal/organization destination.
 */
export function createCompanyBrainGovernedWriteRouter(
  options: CompanyBrainGovernedWriteRouterOptions,
): {
  write: (input: CompanyBrainGovernedWriteInput) => Promise<CompanyBrainGovernedWriteReceiptType>;
} {
  const authority = options.authority ?? writeCompanyBrainGovernedProposal;
  return {
    async write(input) {
      const attempt = CompanyBrainGovernedWriteAttempt.parse(input.attempt);
      const request = CompanyBrainGovernedWriteRequest.parse(input.request);
      const result = await authority(options.db, { attempt, request });
      return CompanyBrainGovernedWriteReceipt.parse(result);
    },
  };
}
