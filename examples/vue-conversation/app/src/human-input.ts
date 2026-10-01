import type { HumanInputAnswer, SessionHumanInputRequest } from "@opengeni/sdk";

export function validateAnswers(
  request: SessionHumanInputRequest,
  answers: HumanInputAnswer[],
): string | null {
  if (request.expiresAt && Date.parse(request.expiresAt) <= Date.now())
    return "This question has expired. Refresh the conversation.";
  for (const question of request.questions) {
    const answer = answers.find((item) => item.questionId === question.id);
    const values = answer?.values.filter((value) => value.trim()) ?? [];
    const hasOther = !!answer?.other?.trim() && question.allowOther;
    if (question.required && !values.length && !hasOther) return `Answer: ${question.prompt}`;
    if (
      question.kind !== "text" &&
      values.some((value) => !question.options.some((option) => option.id === value))
    )
      return "Choose an available option.";
    if (question.kind === "single_select" && values.length > 1) return "Choose one option.";
    if (question.kind === "multi_select") {
      const min = question.validation?.minSelections ?? (question.required ? 1 : 0);
      const max = question.validation?.maxSelections ?? Infinity;
      if ((!hasOther && values.length < min) || values.length > max)
        return `Check the number of options for: ${question.prompt}`;
    }
  }
  return null;
}
