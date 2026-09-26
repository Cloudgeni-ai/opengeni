import { useState } from "react";

import { KitBlock, KitSection, PagePreview, useKitPane } from "../kit";
import { RECOMMENDED_QUESTIONS, type SchedulesQuestions } from "../pages/schedules/model";
import { PreviewControls, PreviewToggle } from "../pages/schedules/preview-controls";
import { SchedulesApp, type InitialForm } from "../pages/schedules/schedules-app";

type Start = "new" | "template" | "edit";

const START_FORMS: Record<Start, InitialForm> = {
  new: { mode: "create" },
  template: { mode: "template", templateId: "template-morning-brief" },
  edit: { mode: "edit", id: "sched-aws-cost" },
};

export default function PageScheduleFormSection() {
  const pane = useKitPane();
  const [start, setStart] = useState<Start>("new");
  const [canRun, setCanRun] = useState<"yes" | "no">("yes");
  const [save, setSave] = useState<"ok" | "fail">("ok");
  const [removeDescription, setRemoveDescription] = useState<"remove" | "keep">("remove");
  const [weekdayDefault, setWeekdayDefault] = useState<"weekdays" | "once">("weekdays");
  const [attachments, setAttachments] = useState<"yes" | "no">("yes");
  const [ongoingOnly, setOngoingOnly] = useState<"ongoing" | "always">("ongoing");
  const [resetKey, setResetKey] = useState(0);

  const questions: SchedulesQuestions = {
    ...RECOMMENDED_QUESTIONS,
    q22RemoveDescription: removeDescription === "remove",
    q23WeekdayDefault: weekdayDefault === "weekdays",
    q24Attachments: attachments === "yes",
    q27OngoingOnly: ongoingOnly === "ongoing",
  };
  const height = pane.mobileFrame ? 780 : pane.count > 1 ? 800 : 880;
  const remount = () => setResetKey((key) => key + 1);

  return (
    <KitSection sectionKey="page-schedule-form">
      <KitBlock
        title="New schedule"
        description="What to do first, then when, then an optional name, with the rest in a closed Advanced section. Opens as a sheet, a page or an inline panel, following your form pick. Try Create with the field empty, pick a one-time date in the past, or open Advanced."
      >
        <PreviewControls
          onReset={remount}
          state={
            <>
              <PreviewToggle
                label="Start from"
                value={start}
                options={[
                  { value: "new", label: "Blank" },
                  { value: "template", label: "Morning brief" },
                  { value: "edit", label: "Edit a schedule" },
                ]}
                onChange={(value) => {
                  setStart(value);
                  remount();
                }}
              />
              <PreviewToggle
                label="This workspace can run schedules"
                value={canRun}
                options={[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No machine connected" },
                ]}
                onChange={setCanRun}
              />
              <PreviewToggle
                label="Saving"
                value={save}
                options={[
                  { value: "ok", label: "Works" },
                  { value: "fail", label: "Fails" },
                ]}
                onChange={setSave}
              />
            </>
          }
          questions={
            <>
              <PreviewToggle
                tag="Q22"
                label="Description field"
                value={removeDescription}
                options={[
                  { value: "remove", label: "Removed" },
                  { value: "keep", label: "Kept" },
                ]}
                onChange={setRemoveDescription}
              />
              <PreviewToggle
                tag="Q23"
                label="New schedules start as"
                value={weekdayDefault}
                options={[
                  { value: "weekdays", label: "Every weekday 09:00" },
                  { value: "once", label: "One time, no monthly" },
                ]}
                onChange={(value) => {
                  setWeekdayDefault(value);
                  remount();
                }}
              />
              <PreviewToggle
                tag="Q24"
                label="Repository, variable set and environment chips"
                value={attachments}
                options={[
                  { value: "yes", label: "Shown" },
                  { value: "no", label: "Hidden" },
                ]}
                onChange={setAttachments}
              />
              <PreviewToggle
                tag="Q27"
                label={'"If still running" shows for'}
                value={ongoingOnly}
                options={[
                  { value: "ongoing", label: "One ongoing chat" },
                  { value: "always", label: "Every schedule" },
                ]}
                onChange={setOngoingOnly}
              />
            </>
          }
        />
        <PagePreview label="Schedule form preview" height={height}>
          <SchedulesApp
            key={`${start}-${weekdayDefault}-${resetKey}`}
            initialForm={START_FORMS[start]}
            questions={questions}
            canRunSchedules={canRun === "yes"}
            saveFails={save === "fail"}
          />
        </PagePreview>
      </KitBlock>
    </KitSection>
  );
}
