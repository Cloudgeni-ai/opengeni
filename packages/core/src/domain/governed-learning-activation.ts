import {
  GovernedLearningActivationCaller,
  ActivateGovernedLearningDecisionRequest,
  UndoGovernedLearningActivationRequest,
  type GovernedLearningActivationReceipt,
  type GovernedLearningActivationUndoReceipt,
} from "@opengeni/contracts";
import {
  activateGovernedLearningDecision,
  undoGovernedLearningActivation,
  type Database,
} from "@opengeni/db";

export function createGovernedLearningActivationController(options: {
  db: Database;
  activate?: typeof activateGovernedLearningDecision;
  undo?: typeof undoGovernedLearningActivation;
}): {
  activate(input: {
    caller: unknown;
    request: unknown;
  }): Promise<GovernedLearningActivationReceipt>;
  undo(input: {
    caller: unknown;
    request: unknown;
  }): Promise<GovernedLearningActivationUndoReceipt>;
} {
  const activate = options.activate ?? activateGovernedLearningDecision;
  const undo = options.undo ?? undoGovernedLearningActivation;
  return {
    async activate(input) {
      return await activate(options.db, {
        caller: GovernedLearningActivationCaller.parse(input.caller),
        request: ActivateGovernedLearningDecisionRequest.parse(input.request),
      });
    },
    async undo(input) {
      return await undo(options.db, {
        caller: GovernedLearningActivationCaller.parse(input.caller),
        request: UndoGovernedLearningActivationRequest.parse(input.request),
      });
    },
  };
}
