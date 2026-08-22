import {
  CompanyProfileAgentAttempt,
  CompanyProfileAgentConfirmRequest,
  CompanyProfileAgentProposalRequest,
  type CompanyProfileAgentConfirmationReceipt,
  type CompanyProfileAgentProposalReceipt,
} from "@opengeni/contracts";
import {
  confirmCompanyProfileForAgent,
  proposeCompanyProfileForAgent,
  type Database,
} from "@opengeni/db";
export { CompanyProfileAgentAdminError } from "@opengeni/db";

export type CompanyProfileAgentAdminRouterOptions = {
  db: Database;
  propose?: typeof proposeCompanyProfileForAgent;
  confirm?: typeof confirmCompanyProfileForAgent;
};

/**
 * Explicit organization administration is intentionally separate from derived
 * workspace learning. The database capabilities own exact-attempt admission,
 * current organization-owner authority, canonical human confirmation,
 * tenant isolation, CAS, and immutable receipts.
 */
export function createCompanyProfileAgentAdminRouter(
  options: CompanyProfileAgentAdminRouterOptions,
): {
  propose: (input: {
    attempt: unknown;
    request: unknown;
  }) => Promise<CompanyProfileAgentProposalReceipt>;
  confirm: (input: {
    attempt: unknown;
    request: unknown;
  }) => Promise<CompanyProfileAgentConfirmationReceipt>;
} {
  const propose = options.propose ?? proposeCompanyProfileForAgent;
  const confirm = options.confirm ?? confirmCompanyProfileForAgent;
  return {
    async propose(input) {
      return await propose(options.db, {
        attempt: CompanyProfileAgentAttempt.parse(input.attempt),
        request: CompanyProfileAgentProposalRequest.parse(input.request),
      });
    },
    async confirm(input) {
      return await confirm(options.db, {
        attempt: CompanyProfileAgentAttempt.parse(input.attempt),
        request: CompanyProfileAgentConfirmRequest.parse(input.request),
      });
    },
  };
}
