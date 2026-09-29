/**
 * Editing a Knowledge source sync: its name and how often it syncs. Syncs
 * index a connector without starting a chat, so they have none of an agent
 * schedule's settings.
 */
import { useState } from "react";
import { toast } from "sonner";

import { Field, FieldStack, TextInput, useField } from "@/components/ui/field";
import { FormPage } from "@/components/ui/form-dialog";
import { Notice } from "@/components/ui/notice";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useAppContext } from "@/context";
import type { ScheduledTask } from "@/types";

import { NAME_MAX_LENGTH } from "./schedule-model";

type SyncCadence = "manual" | "hourly" | "daily";

function cadenceOf(task: ScheduledTask): SyncCadence {
  return task.schedule.type === "manual"
    ? "manual"
    : task.schedule.type === "interval"
      ? "hourly"
      : "daily";
}

function SyncCadenceControl({
  value,
  onChange,
}: {
  value: SyncCadence;
  onChange: (value: SyncCadence) => void;
}) {
  const field = useField();
  return (
    <SegmentedControl<SyncCadence>
      value={value}
      onValueChange={onChange}
      aria-labelledby={field?.labelId}
      aria-describedby={field?.describedBy}
      className="self-start"
      options={[
        { value: "manual", label: "On demand" },
        { value: "hourly", label: "Every hour" },
        { value: "daily", label: "Every day" },
      ]}
    />
  );
}

export function KnowledgeSyncFormPage({
  workspaceId,
  task,
  onCancel,
  onSaved,
}: {
  workspaceId: string;
  task: ScheduledTask;
  onCancel: () => void;
  onSaved: () => void;
}) {
  const { client } = useAppContext();
  const [name, setName] = useState(task.name);
  const [cadence, setCadence] = useState<SyncCadence>(() => cadenceOf(task));
  const [error, setError] = useState<string | undefined>();
  return (
    <FormPage
      title="Edit sync"
      description={task.name}
      submitLabel="Save changes"
      pendingLabel="Saving…"
      back={{ label: task.name, onClick: onCancel }}
      onCancel={onCancel}
      onSubmit={async () => {
        if (name.trim().length > NAME_MAX_LENGTH) {
          setError(`Keep the name under ${NAME_MAX_LENGTH} characters.`);
          return false;
        }
        await client.updateScheduledTask(workspaceId, task.id, {
          name: name.trim() || task.name,
          schedule:
            cadence === "manual"
              ? { type: "manual" }
              : cadence === "hourly"
                ? { type: "interval", everySeconds: 3_600 }
                : { type: "calendar", timeZone: "UTC", hour: 0, minute: 0 },
        });
        toast.success("Changes saved", { description: name.trim() || task.name });
        onSaved();
        return true;
      }}
    >
      <FieldStack>
        <Field label="Name" error={error}>
          <TextInput
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              if (error) setError(undefined);
            }}
            suppressAutofill
          />
        </Field>
        <Field
          label="Sync"
          hint={
            cadence === "daily"
              ? "Once a day at 00:00 UTC."
              : cadence === "hourly"
                ? "On the hour, around the clock."
                : "Only when someone presses Run now."
          }
        >
          <SyncCadenceControl value={cadence} onChange={setCadence} />
        </Field>
        <Notice>
          Syncs bring the source into Knowledge without starting a chat or using agent runs.
        </Notice>
      </FieldStack>
    </FormPage>
  );
}
