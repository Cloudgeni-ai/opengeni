const EMPTY_SKILLS: NonNullable<SkillDiscoveryProps["installedSkills"]> = [];
import { useEffect, useState } from "react";

export type SkillDiscoveryItem = {
  id: string;
  name: string;
  source: string;
  installs: number;
  url: string;
};
export type SkillDiscoveryPage = { items: SkillDiscoveryItem[]; nextCursor: null };
export type SkillDiscoveryClient = {
  searchPublicSkills(workspaceId: string, query: string): Promise<SkillDiscoveryPage>;
};
export type SkillDiscoveryProps = {
  installedSkills?: readonly { name: string; repositoryUrl: string; sourceUrl: string }[];
  client: SkillDiscoveryClient;
  workspaceId: string;
  query: string;
  onImport: (url: string) => void;
  canManage: boolean;
  onSearch?: (() => void) | undefined;
};

/** Host-owned query and import flow; browse presentation is reusable independently. */
export function SkillDiscovery(props: SkillDiscoveryProps) {
  const query = props.query.trim();
  return (
    <section className="og-skill-discovery" aria-label="Discover skills">
      <header>
        <h3>Discover skills</h3>
        <a
          href="https://skills.sh/"
          target="_blank"
          rel="noopener noreferrer"
          className="og-skill-discovery-browse"
        >
          Browse skills.sh ↗
        </a>
      </header>
      {!query && props.onSearch ? (
        <button type="button" className="og-skill-discovery-search" onClick={props.onSearch}>
          Search skills
        </button>
      ) : null}
      <DiscoveryResults key={`${props.workspaceId}:${query}`} {...props} query={query} />
    </section>
  );
}

function DiscoveryResults({
  client,
  workspaceId,
  query,
  canManage,
  onImport,
  installedSkills = EMPTY_SKILLS,
}: SkillDiscoveryProps) {
  const [result, setResult] = useState<SkillDiscoveryPage | null>(null);
  const [loading, setLoading] = useState(query.length >= 2);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    if (query.length < 2) return;
    setLoading(true);
    let timer: ReturnType<typeof setTimeout>;
    const search = async (attempt: number) => {
      try {
        const data = await client.searchPublicSkills(workspaceId, query);
        if (!active) return;
        setResult(data);
        setLoading(false);
      } catch (cause) {
        if (!active) return;
        const status =
          typeof cause === "object" && cause !== null && "status" in cause
            ? cause.status
            : undefined;
        const transient =
          cause instanceof TypeError ||
          (typeof status === "number" && status >= 500 && status <= 599);
        if (attempt === 0 && transient) {
          timer = setTimeout(() => void search(1), 750);
          return;
        }
        setError(true);
        setLoading(false);
      }
    };
    timer = setTimeout(() => void search(0), 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, query, retry]);
  return (
    <div aria-busy={loading}>
      <div className="og-skill-discovery-grid">
        {result?.items.map((skill) => {
          const installed = installedSkills.some(
            (entry) =>
              entry.sourceUrl.replace(/\/$/, "").toLowerCase() === skill.url.toLowerCase() ||
              (entry.repositoryUrl.replace(/\/$/, "").toLowerCase() ===
                `https://github.com/${skill.source}`.toLowerCase() &&
                entry.name.toLowerCase() === skill.name.toLowerCase()),
          );
          return (
            <button
              key={skill.id}
              type="button"
              className="og-skill-discovery-item"
              disabled={!canManage}
              onClick={() => onImport(skill.url)}
            >
              <span className="og-skill-discovery-copy">
                <strong>{skill.name}</strong>
                <span>{skill.source}</span>
                <small>{skill.installs.toLocaleString()} installs</small>
              </span>
              <span className="og-skill-discovery-action">
                {installed ? (
                  <>
                    <span aria-hidden="true">✓ </span>Installed
                  </>
                ) : !canManage ? (
                  "Admin required"
                ) : (
                  "Preview →"
                )}
              </span>
            </button>
          );
        })}
      </div>
      {loading ? <p role="status">Loading skills…</p> : null}
      {error ? (
        <div role="alert" className="og-skill-discovery-error">
          Could not load skills.
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {result && !result.items.length && !loading && !error ? (
        <p role="status">No skills found. Try a different search.</p>
      ) : null}
    </div>
  );
}
