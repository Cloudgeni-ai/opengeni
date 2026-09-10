import { useEffect, useRef, useState } from "react";
import type { ScheduledTask, ScheduledTaskRun } from "@opengeni/sdk";
import { hostRequest } from "./transport";

export function SchedulesPanel() {
  const [tasks, setTasks] = useState<ScheduledTask[]>([]);
  const [runs, setRuns] = useState<{ taskId: string; items: ScheduledTaskRun[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [confirm, setConfirm] = useState<{
    id: string;
    action: "trigger" | "delete";
    operationId: string;
  } | null>(null);
  const alive = useRef(true);
  const pending = useRef(false);
  const readGeneration = useRef(0);
  const load = async () => {
    const generation = ++readGeneration.current;
    const next = await hostRequest<ScheduledTask[]>("schedules");
    if (alive.current && generation === readGeneration.current) {
      setTasks(next);
      setFailed(false);
    }
  };
  useEffect(() => {
    alive.current = true;
    void load().catch(() => {
      if (alive.current) {
        setTasks([]);
        setFailed(true);
      }
    });
    const timer = setInterval(() => {
      if (pending.current) return;
      void load().catch(() => {
        if (alive.current) {
          setTasks([]);
          setRuns(null);
          setFailed(true);
        }
      });
    }, 15_000);
    return () => {
      alive.current = false;
      // Invalidate pending reads; this counter is not a captured DOM ref.
      // eslint-disable-next-line react-hooks/exhaustive-deps
      readGeneration.current++;
      clearInterval(timer);
    };
  }, []);
  const mutate = async (path: string, method: string, body?: unknown) => {
    if (pending.current || failed) return;
    pending.current = true;
    setBusy(true);
    try {
      await hostRequest(path, method, body);
      await load();
    } catch {
      if (alive.current) {
        setFailed(true);
        setTasks([]);
        setRuns(null);
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        setConfirm(null);
      }
    }
  };
  return (
    <section aria-label="Scheduled tasks">
      <h2>Scheduled work</h2>
      <p>
        New tasks start paused. Resume only after reviewing their prompt and schedule. Running a
        task can incur model and tool costs. Normal approval rules still apply.
      </p>
      {failed && (
        <p role="alert">
          The outcome could not be confirmed. Reload live state before another action; do not
          blindly recreate a task.
        </p>
      )}
      <button
        disabled={busy}
        onClick={() =>
          void load().catch(() => {
            setTasks([]);
            setFailed(true);
          })
        }
      >
        Reload scheduled tasks
      </button>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          const data = new FormData(event.currentTarget);
          void mutate("schedules", "POST", {
            name: data.get("name"),
            prompt: data.get("prompt"),
            model: data.get("model"),
            schedule: { type: "interval", everySeconds: Number(data.get("interval")) },
          });
        }}
      >
        <fieldset disabled={busy || failed}>
          <legend>Create paused interval task</legend>
          <label>
            Name <input name="name" required maxLength={200} />
          </label>
          <label>
            Prompt <textarea name="prompt" required maxLength={16384} />
          </label>
          <label>
            Deployment model ID <input name="model" required maxLength={256} />
          </label>
          <label>
            Interval in seconds{" "}
            <input name="interval" type="number" min={1} step={1} defaultValue={3600} required />
          </label>
          <button type="submit">Create paused task</button>
        </fieldset>
      </form>
      <ul>
        {tasks.map((task) => (
          <li key={task.id}>
            <h3>
              {task.name} — {task.status}
            </h3>
            <p>{task.agentConfig.prompt}</p>
            <pre>{JSON.stringify(task.schedule, null, 2)}</pre>
            <button
              disabled={busy || failed}
              onClick={() =>
                void mutate(
                  `schedules/${encodeURIComponent(task.id)}/${task.status === "paused" ? "resume" : "pause"}`,
                  "POST",
                )
              }
            >
              {task.status === "paused" ? "Resume" : "Pause"}
            </button>
            <button
              disabled={busy || failed}
              onClick={() =>
                setConfirm({ id: task.id, action: "trigger", operationId: crypto.randomUUID() })
              }
            >
              Run now…
            </button>
            <button
              disabled={busy || failed}
              onClick={() =>
                setConfirm({ id: task.id, action: "delete", operationId: crypto.randomUUID() })
              }
            >
              Delete…
            </button>
            <button
              disabled={busy || failed}
              onClick={() =>
                void hostRequest<ScheduledTaskRun[]>(
                  `schedules/${encodeURIComponent(task.id)}/runs`,
                )
                  .then((items) => {
                    if (alive.current) setRuns({ taskId: task.id, items });
                  })
                  .catch(() => {
                    if (alive.current) {
                      setRuns(null);
                      setFailed(true);
                    }
                  })
              }
            >
              Recent runs
            </button>
          </li>
        ))}
      </ul>
      {confirm && (
        <div role="group" aria-label="Confirm scheduled task action">
          <p>
            {confirm.action === "trigger"
              ? "Run this task now? This can use paid models and tools."
              : "Delete this schedule? This does not undo completed work."}
          </p>
          <button
            disabled={busy || failed}
            onClick={() =>
              void mutate(
                `schedules/${encodeURIComponent(confirm.id)}${confirm.action === "trigger" ? "/trigger" : ""}`,
                confirm.action === "trigger" ? "POST" : "DELETE",
                confirm.action === "trigger" ? { triggerId: confirm.operationId } : undefined,
              )
            }
          >
            Confirm {confirm.action}
          </button>
          <button disabled={busy} onClick={() => setConfirm(null)}>
            Keep unchanged
          </button>
        </div>
      )}
      {runs && (
        <details open>
          <summary>Recent runs for {runs.taskId}</summary>
          <ul>
            {runs.items.map((run) => (
              <li key={run.id}>
                {run.id} — {run.status}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}
