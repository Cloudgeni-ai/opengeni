/**
 * Secret ask-card answers (`kind: "secret"` questions). The API validates,
 * generates and encrypts each value before the accept transaction; this module
 * writes them to the chosen vault inside that transaction and returns the
 * references that replace them in the stored response. No plaintext secret
 * value reaches this layer, events or the stored response.
 */
import {
  formatSecretReference,
  type HumanInputQuestion,
  type HumanInputSecretAnswerResult,
  type SecretSaveTo,
} from "@opengeni/contracts";
import type { z } from "zod";
import type { Database } from "./database";
import {
  applySecretAnswersInTransaction,
  type SecretAnswerWrite,
  type VaultDbContext,
} from "./vaults";

/** One encrypted value plus its plaintext byte size (checked against vault limits). */
export type PreparedSecretValue = { valueEncrypted: string; valueSize: number };

/** A secret answer after the API validated, generated and encrypted it. */
export type PreparedSecretAnswer = {
  questionId: string;
  saveTo: SecretSaveTo;
  vaultId?: string;
  value: PreparedSecretValue;
  /** The username is not a secret: the agent receives it in plain text (AC-3). */
  username?: PreparedSecretValue & { plain: string };
  generated: boolean;
};

export type SecretAnswerResult = z.infer<typeof HumanInputSecretAnswerResult>;

function secretAnswerWrite(
  question: HumanInputQuestion,
  answer: PreparedSecretAnswer,
): SecretAnswerWrite {
  const spec = question.secret;
  if (!spec) throw new Error(`Question ${question.id} is not a secret question`);
  const fields: NonNullable<SecretAnswerWrite["item"]["fields"]> = [
    {
      name: spec.field,
      kind: spec.fieldKind,
      valueEncrypted: answer.value.valueEncrypted,
      valueSize: answer.value.valueSize,
    },
  ];
  if (answer.username && spec.field.trim().toLowerCase() !== "username") {
    fields.push({
      name: "username",
      kind: "text",
      valueEncrypted: answer.username.valueEncrypted,
      valueSize: answer.username.valueSize,
    });
  }
  return {
    questionId: answer.questionId,
    saveTo: answer.saveTo,
    ...(answer.vaultId ? { vaultId: answer.vaultId } : {}),
    item: {
      name: spec.item,
      type: spec.itemType,
      ...(spec.website ? { websites: [spec.website] } : {}),
      primaryFieldName: spec.field,
      fields,
    },
  };
}

/**
 * Write every answered secret to its vault in the caller's transaction and
 * return what the agent receives instead of the value, keyed by question.
 * A failure throws and rolls the whole response back (AC-2).
 */
export async function applyPreparedSecretAnswersInTransaction(
  tx: Database,
  context: VaultDbContext,
  input: {
    sessionId: string;
    turnId: string;
    questions: readonly HumanInputQuestion[];
    answers: readonly PreparedSecretAnswer[];
  },
): Promise<Map<string, SecretAnswerResult>> {
  const results = new Map<string, SecretAnswerResult>();
  if (input.answers.length === 0) return results;
  const questions = new Map(input.questions.map((question) => [question.id, question]));
  const writes = input.answers.map((answer) => {
    const question = questions.get(answer.questionId);
    if (!question) throw new Error(`Unknown secret question: ${answer.questionId}`);
    return { question, answer, write: secretAnswerWrite(question, answer) };
  });
  const saved = await applySecretAnswersInTransaction(tx, context, {
    sessionId: input.sessionId,
    turnId: input.turnId,
    answers: writes.map((entry) => entry.write),
  });
  for (const { question, answer } of writes) {
    const row = saved.find((entry) => entry.questionId === answer.questionId);
    if (!row) throw new Error(`Secret answer ${answer.questionId} was not saved`);
    const field = question.secret!.field;
    results.set(answer.questionId, {
      reference: formatSecretReference({
        vault: row.item.vaultName,
        item: row.item.name,
        field,
      }),
      username: answer.username?.plain ?? null,
      vaultName: row.item.vaultName,
      itemName: row.item.name,
      saveTo: answer.saveTo,
    });
  }
  return results;
}
