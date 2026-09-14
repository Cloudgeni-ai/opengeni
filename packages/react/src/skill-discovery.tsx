import { useEffect, useState } from "react";
import { createDiscoveryCache } from "./discovery-cache";
import { BookOpenIcon } from "lucide-react";
import { CapabilityCatalogRow, type CapabilityCatalogStatus } from "./capability-catalog-row";

export type SkillDiscoveryItem = {
  id: string;
  name: string;
  source: string;
  installs: number;
  url: string;
};
export type SkillDiscoveryPage = { items: SkillDiscoveryItem[]; nextCursor: null };
const discoveryCache = createDiscoveryCache<SkillDiscoveryPage>();

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
  localSkills?: readonly {
    id: string;
    name: string;
    description?: string;
    status?: CapabilityCatalogStatus;
    statusLabel?: string;
    onOpen: () => void;
  }[];
  resultLimit?: number;
  onShowMore?: () => void;
  onSearch?: (() => void) | undefined;
};

/** Host-owned query and import flow; browse presentation is reusable independently. */
export function SkillDiscovery(props: SkillDiscoveryProps) {
  const query = props.query.trim();
  const discoveryQuery = query || "agent";
  return (
    <section className="og-skill-discovery" aria-label="Discover skills">
      <header>
        <h3>{props.resultLimit ? "Skills" : query ? "Search skills" : "Browse skills"}</h3>
        {!props.resultLimit ? (
          <a
            href="https://skills.sh/"
            target="_blank"
            rel="noopener noreferrer"
            className="og-skill-discovery-browse"
          >
            Browse skills.sh ↗
          </a>
        ) : null}
      </header>
      {!query ? (
        <p>Agent skills from skills.sh. Search above for another topic.</p>
      ) : query.length < 2 ? (
        <p>Enter at least two characters to search skills.sh.</p>
      ) : null}
      <DiscoveryResults
        key={`${props.workspaceId}:${discoveryQuery}`}
        {...props}
        query={discoveryQuery}
      />
    </section>
  );
}

const EMPTY_LOCAL_SKILLS: NonNullable<SkillDiscoveryProps["localSkills"]> = [];
const EMPTY_INSTALLED_SKILLS: NonNullable<SkillDiscoveryProps["installedSkills"]> = [];

function DiscoveryResults({
  client,
  workspaceId,
  query,
  canManage,
  onImport,
  resultLimit,
  onShowMore,
  localSkills = EMPTY_LOCAL_SKILLS,
  installedSkills = EMPTY_INSTALLED_SKILLS,
}: SkillDiscoveryProps) {
  const cacheKey = JSON.stringify([workspaceId, query]);
  const cached = discoveryCache.peek(client, cacheKey);
  const [result, setResult] = useState<SkillDiscoveryPage | null>(cached ?? null);
  const [loading, setLoading] = useState(query.length >= 2 && !cached);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    setError(false);
    if (query.length < 2) return;
    const existing = discoveryCache.peek(client, cacheKey);
    setLoading(!existing);
    let timer: ReturnType<typeof setTimeout>;
    const search = async (attempt: number) => {
      try {
        const data = await discoveryCache.read(client, cacheKey, () =>
          client.searchPublicSkills(workspaceId, query),
        );
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
    timer = setTimeout(() => void search(0), existing ? 0 : 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [client, workspaceId, query, cacheKey, retry]);
  const remoteSkills =
    result?.items.filter(
      (skill) =>
        !localSkills.some((local) => local.name.toLowerCase() === skill.name.toLowerCase()),
    ) ?? [];
  return (
    <div aria-busy={loading}>
      <div className="og-skill-discovery-grid">
        {localSkills.slice(0, resultLimit).map((skill) => (
          <CapabilityCatalogRow
            key={skill.id}
            name={skill.name}
            description={skill.description}
            icon={<BookOpenIcon aria-hidden="true" />}
            status={skill.status ?? "added"}
            statusLabel={skill.statusLabel}
            onOpen={skill.onOpen}
          />
        ))}
        {remoteSkills
          .slice(
            0,
            resultLimit === undefined ? undefined : Math.max(0, resultLimit - localSkills.length),
          )
          .map((skill) => {
            const installed = installedSkills.some(
              (entry) =>
                entry.sourceUrl.replace(/\/$/, "").toLowerCase() === skill.url.toLowerCase() ||
                (entry.repositoryUrl.replace(/\/$/, "").toLowerCase() ===
                  `https://github.com/${skill.source}`.toLowerCase() &&
                  entry.name.toLowerCase() === skill.name.toLowerCase()),
            );
            return (
              <CapabilityCatalogRow
                key={skill.id}
                disabled={!canManage}
                name={skill.name}
                description={skill.source}
                icon={<BookOpenIcon aria-hidden="true" />}
                status={!canManage ? "unavailable" : installed ? "added" : "available"}
                statusLabel={
                  !canManage ? "Admin required" : installed ? "Installed" : "Available to add"
                }
                onOpen={() => onImport(skill.url)}
              />
            );
          })}
      </div>
      {resultLimit && remoteSkills.length + localSkills.length > resultLimit && !loading ? (
        <button className="og-catalog-more" type="button" onClick={onShowMore}>
          View all skills
        </button>
      ) : null}
      {loading ? <p role="status">Loading skills…</p> : null}
      {error ? (
        <div role="alert" className="og-skill-discovery-error">
          Could not load skills.
          <button type="button" onClick={() => setRetry((value) => value + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {result && !remoteSkills.length && !localSkills.length && !loading && !error ? (
        <p role="status">No skills found. Try a different search.</p>
      ) : null}
    </div>
  );
}
