/**
 * The save-time nudge for plain fields (docs/secrets.md, Field kinds). A
 * value that looks like a secret in a field that would be saved as `text`
 * is saved as `concealed` when nobody chose the kind (a new field whose
 * default is text), and kept as text with a note when `text` was asked for
 * or the field already is text. Nothing here refuses a save.
 */
import {
  plainFieldSecretHint,
  type SecretSaveFieldNote,
  type VaultFieldKind,
} from "@opengeni/contracts";

export function plainFieldKind(
  input: { name: string; value: string; kind: VaultFieldKind; chosen: boolean },
  notes: SecretSaveFieldNote[] | undefined,
): VaultFieldKind {
  if (input.kind !== "text") return input.kind;
  const hint = plainFieldSecretHint(input.name, input.value);
  if (!hint) return input.kind;
  if (input.chosen) {
    notes?.push({
      field: input.name,
      kind: "text",
      reason: hint.reason,
      message: `${hint.message} Kept as text; save it with kind "concealed" if it is a secret.`,
    });
    return "text";
  }
  notes?.push({
    field: input.name,
    kind: "concealed",
    reason: hint.reason,
    message: `${hint.message} Saved as concealed; save it with kind "text" if it is not a secret.`,
  });
  return "concealed";
}
