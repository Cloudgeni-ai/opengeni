import type {
  BackgroundJob,
  BackgroundJobArtifact,
  BackgroundJobLog,
  DurableAnswer,
  DurableWait,
  OpenGeniClient,
} from "@opengeni/sdk";
import { DownloadIcon, Loader2Icon, SquareIcon, XIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Notice } from "@/components/ui/notice";
import { useAppContext } from "@/context";
import type { SessionEvent } from "@/types";

type QuestionOption = { value: string; label: string };
type DurableQuestion = {
  id: string;
  type: "text" | "single_select" | "multi_select";
  prompt: string;
  description?: string;
  required: boolean;
  placeholder?: string;
  minLength?: number;
  maxLength?: number;
  options?: QuestionOption[];
  minSelections?: number;
  maxSelections?: number;
};

type AnswerDraft = Record<string, string | string[]>;

export type DurableActionsClient = Pick<
  OpenGeniClient,
  | "listDurableWaits"
  | "resolveAskUser"
  | "listBackgroundJobs"
  | "listBackgroundJobLogs"
  | "listBackgroundJobArtifacts"
  | "createBackgroundJobArtifactDownloadUrl"
  | "cancelBackgroundJob"
>;

function questionsFor(wait: DurableWait): DurableQuestion[] {
  const raw = wait.request.questions;
  if (!Array.isArray(raw)) return [];
  const questions: DurableQuestion[] = [];
  for (const value of raw) {
    if (!value || typeof value !== "object") continue;
    const question = value as Record<string, unknown>;
    if (
      typeof question.id !== "string" ||
      typeof question.prompt !== "string" ||
      (question.type !== "text" &&
        question.type !== "single_select" &&
        question.type !== "multi_select")
    ) {
      continue;
    }
    const options = Array.isArray(question.options)
      ? question.options.flatMap((candidate) => {
          if (!candidate || typeof candidate !== "object") return [];
          const option = candidate as Record<string, unknown>;
          return typeof option.value === "string" && typeof option.label === "string"
            ? [{ value: option.value, label: option.label }]
            : [];
        })
      : undefined;
    questions.push({
      id: question.id,
      type: question.type,
      prompt: question.prompt,
      required: question.required !== false,
      ...(typeof question.description === "string" ? { description: question.description } : {}),
      ...(typeof question.placeholder === "string" ? { placeholder: question.placeholder } : {}),
      ...(typeof question.minLength === "number" ? { minLength: question.minLength } : {}),
      ...(typeof question.maxLength === "number" ? { maxLength: question.maxLength } : {}),
      ...(options ? { options } : {}),
      ...(typeof question.minSelections === "number"
        ? { minSelections: question.minSelections }
        : {}),
      ...(typeof question.maxSelections === "number"
        ? { maxSelections: question.maxSelections }
        : {}),
    });
  }
  return questions;
}

function defaultAnswers(questions: DurableQuestion[]): AnswerDraft {
  return Object.fromEntries(
    questions.map((question) => [question.id, question.type === "multi_select" ? [] : ""]),
  );
}

function statusLabel(status: BackgroundJob["status"]): string {
  switch (status) {
    case "queued":
      return "Queued";
    case "starting":
      return "Starting";
    case "running":
      return "Running";
    case "cancelling":
      return "Cancelling";
    case "completed":
      return "Completed";
    case "failed":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    case "lost":
      return "Execution lost";
  }
}

function isActiveJob(job: BackgroundJob): boolean {
  return ["queued", "starting", "running", "cancelling"].includes(job.status);
}

function formatBytes(bytes: number): string {
  if (bytes < 1_024) return `${bytes} B`;
  if (bytes < 1_048_576) return `${(bytes / 1_024).toFixed(1)} KB`;
  return `${(bytes / 1_048_576).toFixed(1)} MB`;
}

export function DurableActions(props: {
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
}) {
  const { client } = useAppContext();
  return <DurableActionsView {...props} client={client} />;
}

export function DurableActionsView(props: {
  workspaceId: string;
  sessionId: string;
  events: SessionEvent[];
  client: DurableActionsClient;
}) {
  const { client } = props;
  const [waits, setWaits] = useState<DurableWait[]>([]);
  const [jobs, setJobs] = useState<BackgroundJob[]>([]);
  const [logs, setLogs] = useState<Record<string, BackgroundJobLog[]>>({});
  const [artifacts, setArtifacts] = useState<Record<string, BackgroundJobArtifact[]>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [nextWaits, nextJobs] = await Promise.all([
        client.listDurableWaits(props.workspaceId, props.sessionId, { limit: 100 }),
        client.listBackgroundJobs(props.workspaceId, props.sessionId, { limit: 100 }),
      ]);
      const visibleWaits = [
        ...nextWaits.filter((wait) => wait.state === "waiting"),
        ...nextWaits.filter((wait) => wait.state === "resolved").slice(0, 10),
      ];
      const visibleJobs = [
        ...nextJobs.filter(isActiveJob),
        ...nextJobs.filter((job) => !isActiveJob(job)).slice(0, 10),
      ];
      setWaits(visibleWaits);
      setJobs(visibleJobs);
      setError(null);
      await Promise.all(
        visibleJobs.map(async (job) => {
          const [nextLogs, nextArtifacts] = await Promise.all([
            client.listBackgroundJobLogs(props.workspaceId, job.id, { limit: 500 }),
            client.listBackgroundJobArtifacts(props.workspaceId, job.id),
          ]);
          setLogs((current) => ({ ...current, [job.id]: nextLogs }));
          setArtifacts((current) => ({ ...current, [job.id]: nextArtifacts }));
        }),
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [client, props.sessionId, props.workspaceId]);

  const latestSequence = props.events.at(-1)?.sequence ?? 0;
  useEffect(() => {
    setLoading(true);
    void refresh();
  }, [props.sessionId, refresh]);
  useEffect(() => {
    if (latestSequence > 0) void refresh();
  }, [latestSequence, refresh]);
  const hasActiveRows = waits.some((wait) => wait.state === "waiting") || jobs.some(isActiveJob);
  useEffect(() => {
    if (!hasActiveRows) return;
    const interval = window.setInterval(() => void refresh(), 2_000);
    return () => window.clearInterval(interval);
  }, [hasActiveRows, refresh]);

  if (loading && waits.length === 0 && jobs.length === 0) return null;
  if (waits.length === 0 && jobs.length === 0 && !error) return null;

  const askWaits = waits.filter((wait) => wait.kind === "ask_user");
  const passiveWaits = waits.filter((wait) => wait.kind === "until" || wait.kind === "event");

  return (
    <section
      aria-label="Durable actions"
      className="mx-auto w-full max-w-3xl space-y-3 px-4 pb-2 sm:px-6"
    >
      {error ? (
        <Notice tone="failed" title="Durable status unavailable">
          <p>{error}</p>
          <Button size="sm" variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </Notice>
      ) : null}

      {askWaits.map((wait) => (
        <AskUserCard
          key={wait.id}
          client={client}
          workspaceId={props.workspaceId}
          wait={wait}
          onRefresh={refresh}
        />
      ))}

      {passiveWaits.map((wait) => (
        <Notice
          key={wait.id}
          tone={wait.state === "waiting" ? "waiting" : "info"}
          title={wait.kind === "until" ? "Waiting until a scheduled time" : "Waiting for an event"}
        >
          <p className="text-sm text-muted-foreground">
            {wait.state === "waiting"
              ? wait.kind === "until"
                ? `This session will continue at ${wait.wakeAt ? new Date(wait.wakeAt).toLocaleString() : "the configured time"}.`
                : "This session will continue when the authorized matching event arrives."
              : `Finished: ${(wait.outcome ?? "resolved").replaceAll("_", " ")}.`}
          </p>
        </Notice>
      ))}

      {jobs.map((job) => (
        <BackgroundJobCard
          key={job.id}
          client={client}
          workspaceId={props.workspaceId}
          job={job}
          logs={logs[job.id] ?? []}
          artifacts={artifacts[job.id] ?? []}
          onRefresh={refresh}
        />
      ))}
    </section>
  );
}

function AskUserCard(props: {
  client: DurableActionsClient;
  workspaceId: string;
  wait: DurableWait;
  onRefresh: () => Promise<void>;
}) {
  const { client } = props;
  const questions = useMemo(() => questionsFor(props.wait), [props.wait]);
  const [answers, setAnswers] = useState<AnswerDraft>(() => defaultAnswers(questions));
  const [submitting, setSubmitting] = useState<"answer" | "cancel" | null>(null);
  const title =
    typeof props.wait.request.title === "string" ? props.wait.request.title : "Input needed";
  const description =
    typeof props.wait.request.description === "string" ? props.wait.request.description : null;

  if (props.wait.state === "resolved") {
    return (
      <Notice tone="info" title={title}>
        <p className="text-sm text-muted-foreground">
          {props.wait.outcome === "answered"
            ? "Answered and resumed."
            : props.wait.outcome === "timed_out"
              ? "Timed out without an answer."
              : "Cancelled without an answer."}
        </p>
      </Notice>
    );
  }

  const validationError = validateAnswers(questions, answers);
  const resolve = async (outcome: "answer" | "cancel") => {
    setSubmitting(outcome);
    try {
      if (outcome === "answer") {
        if (validationError) throw new Error(validationError);
        const resolvedAnswers: DurableAnswer[] = questions.map((question) => ({
          questionId: question.id,
          value: answers[question.id] ?? (question.type === "multi_select" ? [] : ""),
        }));
        await client.resolveAskUser(props.workspaceId, props.wait.sessionId, props.wait.id, {
          outcome: "answered",
          answers: resolvedAnswers,
          clientEventId: crypto.randomUUID(),
        });
      } else {
        await client.resolveAskUser(props.workspaceId, props.wait.sessionId, props.wait.id, {
          outcome: "cancelled",
          reason: "Cancelled by the user",
          clientEventId: crypto.randomUUID(),
        });
      }
      await props.onRefresh();
    } catch (cause) {
      toast.error(
        outcome === "answer" ? "Couldn't submit answers" : "Couldn't cancel the question",
        {
          description: cause instanceof Error ? cause.message : String(cause),
        },
      );
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <Notice tone="waiting" title={title}>
      {description ? <p className="text-sm text-muted-foreground">{description}</p> : null}
      {props.wait.reminderSequence > 0 ? (
        <p className="text-xs text-muted-foreground" role="status">
          Reminder {props.wait.reminderSequence}: this session is still waiting for your answer.
        </p>
      ) : null}
      <form
        className="space-y-4"
        onSubmit={(event) => {
          event.preventDefault();
          void resolve("answer");
        }}
      >
        {questions.map((question) => (
          <QuestionField
            key={question.id}
            question={question}
            value={answers[question.id] ?? (question.type === "multi_select" ? [] : "")}
            onChange={(value) => setAnswers((current) => ({ ...current, [question.id]: value }))}
          />
        ))}
        {validationError ? (
          <p className="text-xs text-destructive" role="alert">
            {validationError}
          </p>
        ) : null}
        <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={submitting !== null}
            onClick={() => void resolve("cancel")}
          >
            {submitting === "cancel" ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <XIcon className="size-3.5" />
            )}
            Cancel wait
          </Button>
          <Button
            type="submit"
            size="sm"
            disabled={submitting !== null || Boolean(validationError)}
          >
            {submitting === "answer" ? <Loader2Icon className="size-3.5 animate-spin" /> : null}
            Submit answers
          </Button>
        </div>
      </form>
    </Notice>
  );
}

function QuestionField(props: {
  question: DurableQuestion;
  value: string | string[];
  onChange: (value: string | string[]) => void;
}) {
  const hintId = `durable-question-${props.question.id}-hint`;
  if (props.question.type === "text") {
    return (
      <label className="block space-y-1.5">
        <span className="text-sm font-medium">
          {props.question.prompt}
          {props.question.required ? " *" : ""}
        </span>
        {props.question.description ? (
          <span id={hintId} className="block text-xs text-muted-foreground">
            {props.question.description}
          </span>
        ) : null}
        <textarea
          className="min-h-20 w-full rounded-md border bg-background px-3 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring"
          value={typeof props.value === "string" ? props.value : ""}
          placeholder={props.question.placeholder}
          minLength={props.question.minLength}
          maxLength={props.question.maxLength}
          required={props.question.required}
          aria-describedby={props.question.description ? hintId : undefined}
          onInput={(event) => props.onChange(event.currentTarget.value)}
        />
      </label>
    );
  }

  const selected = Array.isArray(props.value) ? props.value : [];
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">
        {props.question.prompt}
        {props.question.required ? " *" : ""}
      </legend>
      {props.question.description ? (
        <p id={hintId} className="text-xs text-muted-foreground">
          {props.question.description}
        </p>
      ) : null}
      <div
        className="grid gap-2 sm:grid-cols-2"
        aria-describedby={props.question.description ? hintId : undefined}
      >
        {(props.question.options ?? []).map((option) => {
          const checked =
            props.question.type === "single_select"
              ? props.value === option.value
              : selected.includes(option.value);
          return (
            <label
              key={option.value}
              className="flex min-h-10 cursor-pointer items-center gap-2 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
            >
              <input
                type={props.question.type === "single_select" ? "radio" : "checkbox"}
                name={`durable-question-${props.question.id}`}
                value={option.value}
                checked={checked}
                onChange={(event) => {
                  if (props.question.type === "single_select") {
                    props.onChange(option.value);
                    return;
                  }
                  props.onChange(
                    event.target.checked
                      ? [...selected, option.value]
                      : selected.filter((value) => value !== option.value),
                  );
                }}
              />
              <span>{option.label}</span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

function validateAnswers(questions: DurableQuestion[], answers: AnswerDraft): string | null {
  for (const question of questions) {
    const value = answers[question.id];
    if (question.type === "text") {
      const text = typeof value === "string" ? value : "";
      if (question.required && text.trim().length === 0) return `${question.prompt} is required.`;
      if (question.minLength !== undefined && text.length < question.minLength) {
        return `${question.prompt} must be at least ${question.minLength} characters.`;
      }
      continue;
    }
    if (question.type === "single_select") {
      if (question.required && typeof value !== "string") return `${question.prompt} is required.`;
      if (question.required && value === "") return `${question.prompt} is required.`;
      continue;
    }
    const selected = Array.isArray(value) ? value : [];
    const minimum = question.minSelections ?? (question.required ? 1 : 0);
    if (selected.length < minimum)
      return `${question.prompt} needs at least ${minimum} selection${minimum === 1 ? "" : "s"}.`;
    if (question.maxSelections !== undefined && selected.length > question.maxSelections) {
      return `${question.prompt} allows at most ${question.maxSelections} selections.`;
    }
  }
  return null;
}

function BackgroundJobCard(props: {
  client: DurableActionsClient;
  workspaceId: string;
  job: BackgroundJob;
  logs: BackgroundJobLog[];
  artifacts: BackgroundJobArtifact[];
  onRefresh: () => Promise<void>;
}) {
  const { client } = props;
  const [cancelling, setCancelling] = useState(false);
  const [downloading, setDownloading] = useState<string | null>(null);
  const active = isActiveJob(props.job);
  const title =
    typeof props.job.spec.metadata.title === "string"
      ? props.job.spec.metadata.title
      : props.job.spec.command;

  return (
    <Notice
      tone={
        props.job.status === "failed" || props.job.status === "lost"
          ? "failed"
          : active
            ? "waiting"
            : "info"
      }
      title={title}
    >
      <div className="flex flex-col gap-2 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p aria-live="polite">
          <span className="font-medium">{statusLabel(props.job.status)}</span>
          {props.job.exitCode !== null ? ` · exit ${props.job.exitCode}` : ""}
        </p>
        {active ? (
          <Button
            size="sm"
            variant="ghost"
            disabled={cancelling || props.job.status === "cancelling"}
            onClick={() => {
              setCancelling(true);
              void client
                .cancelBackgroundJob(props.workspaceId, props.job.id)
                .then(props.onRefresh)
                .catch((cause) =>
                  toast.error("Couldn't cancel background job", {
                    description: cause instanceof Error ? cause.message : String(cause),
                  }),
                )
                .finally(() => setCancelling(false));
            }}
          >
            {cancelling ? (
              <Loader2Icon className="size-3.5 animate-spin" />
            ) : (
              <SquareIcon className="size-3.5" />
            )}
            Cancel job
          </Button>
        ) : null}
      </div>
      {props.job.error ? <p className="text-sm text-destructive">{props.job.error}</p> : null}
      {props.logs.length > 0 ? (
        <pre
          tabIndex={0}
          aria-label={`Logs for ${title}`}
          className="max-h-56 overflow-auto rounded-md bg-muted/70 p-3 font-mono text-xs whitespace-pre-wrap"
        >
          {props.logs.map((log) => log.text).join("")}
        </pre>
      ) : active ? (
        <p className="text-xs text-muted-foreground">Waiting for output…</p>
      ) : null}
      {props.artifacts.length > 0 ? (
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Artifacts
          </h4>
          <ul className="grid gap-2 sm:grid-cols-2">
            {props.artifacts.map((artifact) => (
              <li key={artifact.id}>
                <Button
                  type="button"
                  variant="secondary"
                  size="sm"
                  className="h-auto w-full justify-start py-2 text-left"
                  disabled={downloading === artifact.id}
                  onClick={() => {
                    setDownloading(artifact.id);
                    void client
                      .createBackgroundJobArtifactDownloadUrl(
                        props.workspaceId,
                        props.job.id,
                        artifact.id,
                      )
                      .then(({ url }) => window.open(url, "_blank", "noopener,noreferrer"))
                      .catch((cause) =>
                        toast.error("Couldn't download artifact", {
                          description: cause instanceof Error ? cause.message : String(cause),
                        }),
                      )
                      .finally(() => setDownloading(null));
                  }}
                >
                  {downloading === artifact.id ? (
                    <Loader2Icon className="size-3.5 shrink-0 animate-spin" />
                  ) : (
                    <DownloadIcon className="size-3.5 shrink-0" />
                  )}
                  <span className="min-w-0">
                    <span className="block truncate">{artifact.filename}</span>
                    <span className="block text-xs text-muted-foreground">
                      {formatBytes(artifact.sizeBytes)} · SHA-256 {artifact.sha256.slice(0, 12)}…
                    </span>
                  </span>
                </Button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </Notice>
  );
}
