import type { ConnectionMetadata } from "@opengeni/contracts";
import {
  getConnectionMetadataByIds,
  isSubjectOwnPersonalWorkspace,
  listOwnedConnectionAccountsAndLoginsTurnedOn,
  namedSubjectHasLiveWorkspaceAuthority,
  type Database,
} from "@opengeni/db";

type Owner = { accountId: string; workspaceId: string; subjectId: string };

/** One owner's own accounts as `listOwnConnectionMetadata` reads them. */
export type OwnConnectionAccounts = {
  accounts: Array<{ connectionId: string; originWorkspaceId: string }>;
  /** `workspaceId` is the owner's own Personal workspace. */
  personalWorkspace: boolean;
  /** Logins turned on in `workspaceId`; empty in the Personal workspace. */
  turnedOn: Map<string, string>;
};

/**
 * The reads one connection-account resolution makes, for a caller that runs
 * them all on one transaction (the turn claim). Each read is the same read,
 * in the same security context, as the unshared path makes; it is only made
 * once per resolution instead of once per caller, and reads that share a
 * context share one scope:
 *
 * - live workspace authority, the Personal-workspace check and the owner's
 *   accounts are read once per owner and workspace;
 * - the owner's accounts and the logins turned on in the workspace are read in
 *   their one owner scope;
 * - connection metadata is read by ids, one scope per origin workspace, and
 *   each connection only once.
 *
 * Under READ COMMITTED every statement takes a fresh snapshot, so a repeated
 * read could see a write committed in between. Reading once gives the answer
 * the repeated reads give when nothing commits in between, which is one of the
 * answers the repeated reads could give. Nothing is kept past the resolution.
 *
 * A failed read is not kept: a later caller reads again, as it would without
 * sharing. Callers get copies, so nothing they change reaches another caller.
 */
export class ConnectionAccountReads {
  readonly #db: Database;
  readonly #reads = new Map<string, Promise<unknown>>();
  readonly #metadata = new Map<string, ConnectionMetadata | null>();

  constructor(db: Database) {
    this.#db = db;
  }

  #once<T>(key: string, read: () => Promise<T>): Promise<T> {
    const known = this.#reads.get(key);
    if (known) return known as Promise<T>;
    const pending = read();
    this.#reads.set(key, pending);
    pending.catch(() => {
      if (this.#reads.get(key) === pending) this.#reads.delete(key);
    });
    return pending;
  }

  /** `namedSubjectHasLiveWorkspaceAuthority`, read once. */
  async ownerHasLiveWorkspaceAuthority(owner: Owner): Promise<boolean> {
    return await this.#once(`authority\u0000${ownerKey(owner)}`, () =>
      namedSubjectHasLiveWorkspaceAuthority(this.#db, owner),
    );
  }

  /** `isSubjectOwnPersonalWorkspace`, read once (its own error-isolating scope). */
  async isOwnPersonalWorkspace(owner: Owner): Promise<boolean> {
    return await this.#once(`personal\u0000${ownerKey(owner)}`, () =>
      isSubjectOwnPersonalWorkspace(this.#db, owner),
    );
  }

  /**
   * The owner's accounts and, outside their Personal workspace, the logins
   * turned on here: `listOwnedConnectionAccounts` and `listOwnLoginsTurnedOn`
   * in one owner scope, read once. Logins are read only when there is an
   * account, as `listOwnConnectionMetadata` reads them.
   */
  async ownConnectionAccounts(owner: Owner): Promise<OwnConnectionAccounts> {
    // A resolution checks the Personal workspace before it lists accounts
    // (`personalWorkspaceOwnerOriginConnections`), so this is already known.
    const personalWorkspace = await this.isOwnPersonalWorkspace(owner);
    const read = await this.#once(`own\u0000${ownerKey(owner)}`, () =>
      listOwnedConnectionAccountsAndLoginsTurnedOn(this.#db, {
        ...owner,
        loginsTurnedOn: !personalWorkspace,
      }),
    );
    return {
      accounts: read.accounts.map((account) => ({ ...account })),
      personalWorkspace,
      turnedOn: new Map(read.turnedOn ?? []),
    };
  }

  /**
   * `getConnectionMetadata` for each id, keyed by id: ids not read yet in this
   * resolution are read together in one scope of `workspaceId`.
   */
  async connectionMetadata(
    workspaceId: string,
    connectionIds: readonly string[],
    subjectId: string | null,
  ): Promise<Map<string, ConnectionMetadata | null>> {
    const key = (connectionId: string) =>
      [workspaceId, subjectId ?? "", connectionId].join("\u0000");
    const unread = [...new Set(connectionIds)].filter((id) => !this.#metadata.has(key(id)));
    if (unread.length > 0) {
      const read = await getConnectionMetadataByIds(this.#db, workspaceId, unread, subjectId);
      for (const id of unread) this.#metadata.set(key(id), read.get(id) ?? null);
    }
    return new Map(
      connectionIds.map((id) => {
        const connection = this.#metadata.get(key(id)) ?? null;
        return [id, connection ? structuredClone(connection) : null];
      }),
    );
  }
}

function ownerKey(owner: Owner): string {
  return [owner.accountId, owner.workspaceId, owner.subjectId].join("\u0000");
}
