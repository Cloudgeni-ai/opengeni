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
    if (answer?.other?.trim() && (!question.allowOther || question.kind === "text"))
      return "Use an available answer field.";
    const hasOther = !!answer?.other?.trim() && question.allowOther;
    const suppliedCount = values.length + (hasOther ? 1 : 0);
    if (question.required && !values.length && !hasOther) return `Answer: ${question.prompt}`;
    if (new Set(values).size !== values.length) return "Choose each option only once.";
    if (question.kind === "text" && values.length > 1) return "Enter one text answer.";
    if (
      question.kind !== "text" &&
      values.some((value) => !question.options.some((option) => option.id === value))
    )
      return "Choose an available option.";
    if (question.kind === "single_select" && suppliedCount > 1)
      return "Choose one option, or clear it to use Other.";
    if (question.kind === "multi_select") {
      const min = question.validation?.minSelections ?? (question.required ? 1 : 0);
      const max = question.validation?.maxSelections ?? Infinity;
      if (suppliedCount < min || suppliedCount > max)
        return `Check the number of options for: ${question.prompt}`;
    }
  }
  return null;
}
