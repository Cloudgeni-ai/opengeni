/** These routine repairs depend on the actor/Skill/Knowledge writers installed
 * by 0461. Historical fixtures withhold them and replay them after that cutover. */
export const knowledgeActorMigrationTail = [
  "0813_preserve_accepted_learning_scope.sql",
  "0819_explicit_workspace_learning_destination.sql",
  "0824_explicit_learning_destination_symmetry.sql",
  "0868_humanless_personal_workspace_learning.sql",
] as const;
