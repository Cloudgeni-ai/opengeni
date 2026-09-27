import { BookOpenIcon, Loader2Icon } from "lucide-react";
import type { SkillImportPreview } from "@opengeni/contracts";
import { Markdown } from "@opengeni/react";

import {
  CapabilityAside,
  CapabilityMark,
  CapabilityPage,
  TechnicalDetails,
} from "@/components/capabilities/capability-page";
import { humanizeName, skillBody, skillSummary } from "@/components/capabilities/skill-copy";
import { RowButton } from "@/components/models/models-ui";
import { Button } from "@/components/ui/button";
import { DetailSection } from "@/components/ui/detail-sheet";
import { Notice } from "@/components/ui/notice";

/* ----------------------------------------------------------------------------
   A skill from skills.sh or GitHub before it is installed: the author's own
   summary (never the model-facing trigger text in the frontmatter), the
   rendered SKILL.md, and Install skill. The pinned commit and hashes are in
   Technical details.
   -------------------------------------------------------------------------- */

function nameFromUrl(url: string): string {
  try {
    const parts = new URL(url).pathname.split("/").filter(Boolean);
    const last = parts.at(-1) === "SKILL.md" ? parts.at(-2) : parts.at(-1);
    return last ? humanizeName(decodeURIComponent(last)) : "Skill";
  } catch {
    return "Skill";
  }
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function SkillSourcePage({
  url,
  preview,
  loading,
  installing,
  error,
  validationError,
  canManage,
  onInstall,
  onRetry,
  onBack,
}: {
  url: string;
  preview: SkillImportPreview | null;
  loading: boolean;
  installing: boolean;
  error: string | null;
  validationError: string | null;
  canManage: boolean;
  onInstall: () => void;
  onRetry: () => void;
  onBack: () => void;
}) {
  const title = preview ? humanizeName(preview.name) : nameFromUrl(url);
  const from = preview
    ? preview.source === "skills_sh"
      ? `From ${preview.owner} on skills.sh`
      : `From ${preview.owner}/${preview.repository} on GitHub`
    : null;
  const body = skillBody(preview?.markdown);
  const summary = skillSummary(preview?.markdown);
  return (
    <CapabilityPage
      onBack={onBack}
      mark={<CapabilityMark name={title} icon={<BookOpenIcon />} />}
      title={title}
      status={preview?.installed ? "Installed" : undefined}
      meta={[from, "Skill"]}
      actions={
        preview ? (
          <Button
            type="button"
            size="sm"
            className="rounded-[10px] pointer-coarse:h-11"
            disabled={!canManage || installing || Boolean(validationError)}
            title={!canManage ? "Only workspace admins can install skills." : undefined}
            onClick={onInstall}
          >
            {installing ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            {preview.installed ? "Update skill" : "Install skill"}
          </Button>
        ) : undefined
      }
      aside={
        preview ? (
          <CapabilityAside
            name={title}
            items={[
              { label: "Made by", value: preview.owner },
              { label: "Source", value: preview.source === "skills_sh" ? "skills.sh" : "GitHub" },
              {
                label: "Files",
                value: `${preview.files.length} ${preview.files.length === 1 ? "file" : "files"}`,
              },
              {
                label: "In this workspace",
                value: preview.installed ? "Installed" : "Not installed",
              },
            ]}
          />
        ) : undefined
      }
    >
      {error ? (
        <DetailSection>
          <Notice tone="failed" title="That didn't work">
            <span role="alert">{error}</span>
          </Notice>
        </DetailSection>
      ) : null}

      {!preview ? (
        <DetailSection>
          {loading ? (
            <p role="status" className="m-0 flex items-center gap-2 text-sm text-fg-muted">
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              Loading skill…
            </p>
          ) : (
            <div className="flex flex-wrap items-center gap-3">
              <RowButton onClick={onRetry}>Try again</RowButton>
              <a
                href={url}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm font-medium text-brand hover:underline"
              >
                View source
              </a>
            </div>
          )}
        </DetailSection>
      ) : (
        <>
          <DetailSection title="About">
            <p className="m-0 text-sm leading-6 text-fg">
              {summary ?? "Instructions agents load when they need them."}
            </p>
            <p className="mt-3 mb-0 text-xs leading-4.5 text-fg-muted">
              Skills add instructions only. They never get credentials or connect accounts.
              {!canManage ? " Only workspace admins can install skills." : ""}
            </p>
            {validationError ? (
              <p className="mt-3 mb-0 text-xs leading-4.5 text-danger">{validationError}</p>
            ) : null}
            {preview.warnings.length ? (
              <ul className="mt-2 mb-0 grid list-none gap-1 p-0 text-xs leading-4.5 text-fg-muted">
                {preview.warnings.map((warning) => (
                  <li key={warning}>{warning}</li>
                ))}
              </ul>
            ) : null}
          </DetailSection>
          {body ? (
            <DetailSection title="Contents" description="SKILL.md, as agents will read it.">
              <div className="min-w-0 text-sm leading-6 text-fg">
                <Markdown streaming={false}>{body}</Markdown>
              </div>
            </DetailSection>
          ) : null}
          <DetailSection title={`Files ${preview.files.length}`}>
            <ul className="m-0 grid list-none gap-1.5 p-0">
              {preview.files.map((file) => (
                <li
                  key={file.path}
                  className="flex min-w-0 items-baseline justify-between gap-4 text-xs leading-5"
                >
                  <span className="min-w-0 font-mono break-all text-fg">{file.path}</span>
                  <span className="shrink-0 text-fg-subtle">{formatBytes(file.byteSize)}</span>
                </li>
              ))}
            </ul>
          </DetailSection>
          <TechnicalDetails
            facts={[
              {
                label: "Source",
                value: (
                  <a
                    href={preview.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="font-medium text-brand hover:underline"
                  >
                    {preview.sourceUrl.replace(/^https?:\/\//, "")}
                  </a>
                ),
              },
              { label: "Key", value: preview.name, mono: true },
              { label: "Path", value: preview.sourcePath, mono: true },
              { label: "Source version", value: preview.sourceCommit, mono: true },
              { label: "Content hash", value: preview.contentSha256, mono: true },
              { label: "Size", value: formatBytes(preview.totalBytes) },
            ]}
          />
        </>
      )}
    </CapabilityPage>
  );
}
