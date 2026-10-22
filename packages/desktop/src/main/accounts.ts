import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { normalizeServerUrl, type AppLinkAccount } from "@opengeni/sdk/app-links";

/**
 * The server address a server's install script left in the app's data folder
 * (`default-server`) for the first sign-in, or "" when there is none.
 */
export function readInstalledFrom(dataDir: string): string {
  try {
    return normalizeServerUrl(readFileSync(join(dataDir, "default-server"), "utf8")) ?? "";
  } catch {
    return "";
  }
}

/**
 * One signed-in identity on one server. The app keeps several (other servers,
 * other people) and shows one at a time. The credential is the app's own
 * revocable session from the server's native sign-in; it is stored encrypted
 * by the operating system and never leaves the main process.
 */
export interface StoredAccount extends AppLinkAccount {
  subjectId: string;
  email: string;
  signedOut?: boolean;
  /** The workspace or session page the window last showed, reopened at launch. */
  lastPath?: string;
}

export interface AccountsState {
  accounts: StoredAccount[];
  activeId: string | null;
}

/** The operating system's secret storage (Electron `safeStorage`). */
export interface SecretCipher {
  available(): boolean;
  encrypt(plain: string): Buffer;
  decrypt(sealed: Buffer): string;
}

const INDEX_FILE = "accounts.json";
const TOKENS_DIR = "credentials";

function writeAtomic(path: string, data: string | Buffer): void {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, data, { mode: 0o600 });
  renameSync(temporary, path);
}

function isStoredAccount(value: unknown): value is StoredAccount {
  if (!value || typeof value !== "object") return false;
  const account = value as Record<string, unknown>;
  return (
    typeof account.id === "string" &&
    typeof account.baseUrl === "string" &&
    typeof account.subjectId === "string" &&
    typeof account.email === "string" &&
    (account.workspaceId === null || typeof account.workspaceId === "string")
  );
}

/**
 * The account list (a small JSON file read synchronously at launch, so the
 * first window knows what to show without waiting) and the encrypted
 * credentials next to it.
 */
export class AccountStore {
  private state: AccountsState;

  constructor(
    private readonly directory: string,
    private readonly cipher: SecretCipher,
  ) {
    mkdirSync(join(directory, TOKENS_DIR), { recursive: true, mode: 0o700 });
    this.state = this.read();
  }

  snapshot(): AccountsState {
    return {
      accounts: this.state.accounts.map((account) => ({ ...account })),
      activeId: this.state.activeId,
    };
  }

  get(id: string): StoredAccount | null {
    return this.state.accounts.find((account) => account.id === id) ?? null;
  }

  active(): StoredAccount | null {
    return this.state.activeId ? this.get(this.state.activeId) : null;
  }

  setActive(id: string | null): void {
    if (id !== null && !this.get(id)) return;
    this.state.activeId = id;
    this.write();
  }

  /**
   * Add a freshly signed-in identity. The same person on the same server is
   * the same account signed in again: it keeps its id, so its window, its
   * browser storage and its links stay put.
   */
  upsert(input: Omit<StoredAccount, "id">, token: string): StoredAccount {
    const baseUrl = normalizeServerUrl(input.baseUrl) ?? input.baseUrl;
    const existing = this.state.accounts.find(
      (account) => account.baseUrl === baseUrl && account.subjectId === input.subjectId,
    );
    const account: StoredAccount = {
      ...existing,
      ...input,
      baseUrl,
      id: existing?.id ?? randomUUID(),
      workspaceId: input.workspaceId ?? existing?.workspaceId ?? null,
    };
    delete account.signedOut;
    this.writeToken(account.id, token);
    this.state.accounts = existing
      ? this.state.accounts.map((candidate) => (candidate.id === account.id ? account : candidate))
      : [...this.state.accounts, account];
    this.state.activeId = account.id;
    this.write();
    return account;
  }

  update(
    id: string,
    patch: Partial<Pick<StoredAccount, "workspaceId" | "email" | "signedOut" | "lastPath">>,
  ): void {
    const account = this.get(id);
    if (!account) return;
    const next = { ...account, ...patch };
    if (!next.signedOut) delete next.signedOut;
    if (JSON.stringify(next) === JSON.stringify(account)) return;
    this.state.accounts = this.state.accounts.map((candidate) =>
      candidate.id === id ? next : candidate,
    );
    this.write();
  }

  /** Remove an account and its credential. The active account moves to the next one. */
  remove(id: string): void {
    rmSync(this.tokenPath(id), { force: true });
    this.state.accounts = this.state.accounts.filter((account) => account.id !== id);
    if (this.state.activeId === id) this.state.activeId = this.state.accounts[0]?.id ?? null;
    this.write();
  }

  token(id: string): string | null {
    try {
      return this.cipher.decrypt(readFileSync(this.tokenPath(id)));
    } catch {
      return null;
    }
  }

  private writeToken(id: string, token: string): void {
    if (!this.cipher.available()) {
      throw new Error("This computer has no secure storage for the sign-in.");
    }
    writeAtomic(this.tokenPath(id), this.cipher.encrypt(token));
  }

  private tokenPath(id: string): string {
    if (!/^[A-Za-z0-9-]{1,64}$/u.test(id)) throw new Error("Invalid account id");
    return join(this.directory, TOKENS_DIR, `${id}.bin`);
  }

  private read(): AccountsState {
    try {
      const parsed = JSON.parse(readFileSync(join(this.directory, INDEX_FILE), "utf8")) as {
        accounts?: unknown;
        activeId?: unknown;
      };
      const accounts = Array.isArray(parsed.accounts)
        ? parsed.accounts.filter(isStoredAccount)
        : [];
      const activeId =
        typeof parsed.activeId === "string" &&
        accounts.some((account) => account.id === parsed.activeId)
          ? parsed.activeId
          : (accounts[0]?.id ?? null);
      return { accounts, activeId };
    } catch {
      return { accounts: [], activeId: null };
    }
  }

  private write(): void {
    writeAtomic(join(this.directory, INDEX_FILE), `${JSON.stringify(this.state, null, 2)}\n`);
  }
}
