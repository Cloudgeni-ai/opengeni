/**
 * Whether a variable, header, field, option or key name says its value is a
 * credential (docs/secrets.md). Names are read word by word (`_`, `-`, `.`,
 * spaces and camelCase separate words; trailing digits are dropped), so
 * `AUTH` does not match inside `GIT_AUTHOR_NAME`. A word may end in a
 * credential word (`PGPASSWORD`, `DBPWD`, `masterauth`, `JSESSIONID`) or
 * start with one (`TOKENVALUE`).
 *
 * Pure, with no imports: secret masking and the plain-field hints share it.
 */

/**
 * A whole word that says the value is a credential. `session` and `private`
 * alone do not (`--session main`, `private: true`), nor does `key` as the
 * only word of a name (`--key reports/q3.csv`); `SESSION_TOKEN`,
 * `private_key` and `api_key` do.
 */
const SECRET_NAME_WORD =
  /^(?:tokens?|secrets?|passwords?|passwd|passphrases?|passcodes?|pass|pwd|pw|keys?|apikeys?|keystore|credentials?|creds|auth|authorization|authentication|cookies?|bearer|signature|jwt)$/iu;
/** Words that count only next to another word: `api_key`, not `key`. */
const COMPOUND_ONLY_WORD = /^keys?$/iu;
/** Ordinary words that end like a credential word: `bypass`, `monkey`, `hotkey`. */
const BENIGN_WORD =
  /^(?:by|com|encom|over|under|sur|tres|im|mis)pass(?:es)?$|^(?:mon|tur|don|hoc|whis|joc|hot|jer|lac)keys?$/iu;
/** A compound word that ends with one: `PGPASSWORD`, `ACCESSKEY`, `requirepass`, `OAUTH`. */
const SECRET_NAME_SUFFIX =
  /(?:tokens?|secrets?|passwords?|passwd|pass|pwd|pw|keys?|keystore|cookies?|signature|sessionid|auth|credentials?)$/iu;
/** A compound word that starts with one: `TOKENVALUE`, `SECRETDATA`, `PASSWORDHASH`. */
const SECRET_NAME_PREFIX = /^(?:token|secret|passw|credential|apikey)/iu;
/**
 * The last word says the value names, locates or describes something:
 * `GIT_AUTHOR_NAME`, `SESSION_NAME`, `TOKEN_ENDPOINT`, `KEY_ALGORITHM`.
 */
const NON_SECRET_LAST_WORD =
  /^(?:ids?|identifier|names?|user|username|email|host|hostname|url|uri|endpoint|region|path|file|dir|type|kind|mode|version|prefix|scopes?|expiry|expires|expiration|ttl|timeout|length|format|algorithm|issuer|audience|domain|port|method|provider|scheme|strategy|policy|label|title|description)$/iu;
/** The last words of names whose values are plain text even next to a credential word. */
const DESCRIPTIVE_LAST_WORD = /^(?:names?|user|username|email|label|title|description)$/iu;

/** The words of a name, trailing digits dropped: `API_KEY2` is `API`, `KEY`. */
export function credentialNameWords(name: string): string[] {
  if (typeof name !== "string") return [];
  return name
    .replace(/([a-z0-9])([A-Z])/gu, "$1 $2")
    .split(/[^A-Za-z0-9]+/u)
    .map((word) => word.replace(/[0-9]+$/u, ""))
    .filter((word) => word.length > 0);
}

function hasCredentialWord(words: readonly string[]): boolean {
  return words.some(
    (word) =>
      !BENIGN_WORD.test(word) &&
      ((SECRET_NAME_WORD.test(word) && (words.length > 1 || !COMPOUND_ONLY_WORD.test(word))) ||
        (word.length > 4 && (SECRET_NAME_SUFFIX.test(word) || SECRET_NAME_PREFIX.test(word)))),
  );
}

/**
 * Credential words anywhere in a name, as in `PRIVATEKEYPEM`, `AUTHHEADER`,
 * `APITOKENVALUE`, `SESSIONDATA` and `X-Authz`, once ordinary words that
 * contain one are taken out (`GIT_AUTHOR_NAME`, `KEYBOARD_LAYOUT`).
 */
const CREDENTIAL_SUBSTRING =
  /token|secret|passw|pwd|key|credential|auth|session|cookie|bearer|private|signature/iu;
const BENIGN_SUBSTRING =
  /author(?!i[sz])|keyboard|monkey|turkey|donkey|hockey|whiskey|jockey|hotkey|keycloak|keyvault|keyframe|keyword|keymap|keynote|cookiecutter|authority|tokeniz|tokenis/giu;

/**
 * Whether a name says its value is a credential: a credential word, and a
 * last word that does not say the value names, locates or describes
 * something (`SESSION_NAME`, `TOKEN_ENDPOINT`, `AUTH_METHOD` are not).
 */
export function credentialNameSaysSecret(name: string): boolean {
  const words = credentialNameWords(name);
  if (words.length === 0) return false;
  if (NON_SECRET_LAST_WORD.test(words[words.length - 1]!)) return false;
  return hasCredentialWord(words);
}

/**
 * The broader test for credentials Opengeni puts into an attempt (run
 * environment values and MCP headers): a credential word anywhere in the
 * name, even inside another word, unless the last
 * word says the value is a name or label (`SESSION_NAME`). Remembering a
 * value that is not secret costs little, because a word-like value is only
 * replaced where it is the credential.
 */
export function credentialNameMayHoldSecret(name: string): boolean {
  const words = credentialNameWords(name);
  if (words.length === 0) return false;
  if (DESCRIPTIVE_LAST_WORD.test(words[words.length - 1]!)) return false;
  return CREDENTIAL_SUBSTRING.test(name.replace(BENIGN_SUBSTRING, " "));
}

/** Whether a key's last word says its value names, locates or describes something. */
export function credentialNameDescribesValue(name: string): boolean {
  const words = credentialNameWords(name);
  return words.length > 0 && NON_SECRET_LAST_WORD.test(words[words.length - 1]!);
}
