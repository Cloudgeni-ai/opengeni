/** This explicit user-authorized pass begins after the retained 496-attempt ledger. */
export const DIRECT_PASS_BUDGET = {
  baselineAttempts: 496,
  baselineUsd: 1.2872993319999984,
  maxAdditionalAttempts: 40,
  maxAdditionalUsd: 1,
};

/** New improvement pass, retaining all previous native/Gateway attempts. */
export const IMPROVEMENT_PASS_BUDGET = {
  baselineAttempts: 530,
  baselineUsd: 1.3418997759999984,
  maxAdditionalAttempts: 100,
  maxAdditionalUsd: 1,
};
