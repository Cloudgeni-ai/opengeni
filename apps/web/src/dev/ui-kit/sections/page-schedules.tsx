import { useState } from "react";

import { KitBlock, KitSection, PagePreview, useKitPane } from "../kit";
import { RECOMMENDED_QUESTIONS, type SchedulesQuestions } from "../pages/schedules/model";
import { PreviewControls, PreviewToggle } from "../pages/schedules/preview-controls";
import { SchedulesApp, type SchedulesDataState } from "../pages/schedules/schedules-app";
import { ScheduleSheetDemo } from "../pages/schedules/sheet-demo";

const SHOW_OPTIONS = [
  { value: "ready", label: "4 schedules" },
  { value: "empty", label: "Empty" },
  { value: "loading", label: "Loading" },
  { value: "error", label: "Couldn't load" },
] as const;

export default function PageSchedulesSection() {
  const pane = useKitPane();
  const [show, setShow] = useState<SchedulesDataState>("ready");
  const [oneList, setOneList] = useState<"list" | "section">("list");
  const [adminsManage, setAdminsManage] = useState<"yes" | "no">("yes");
  const [ongoingOnly, setOngoingOnly] = useState<"ongoing" | "always">("ongoing");
  const [resetKey, setResetKey] = useState(0);

  const questions: SchedulesQuestions = {
    ...RECOMMENDED_QUESTIONS,
    q25OneList: oneList === "list",
    q26AdminsManage: adminsManage === "yes",
    q27OngoingOnly: ongoingOnly === "ongoing",
  };
  const height = pane.mobileFrame ? 780 : pane.count > 1 ? 760 : 820;

  return (
    <KitSection sectionKey="page-schedules">
      <KitBlock
        title="Schedules"
        description="Click a row to open its sheet, use ⋯ or Resume on a row, or press New schedule. The page follows your picks for the header, rows, detail view, empty state, switch, cadence picker and delete confirm."
      >
        <PreviewControls
          onReset={() => setResetKey((key) => key + 1)}
          state={
            <PreviewToggle
              label="Show"
              value={show}
              options={SHOW_OPTIONS}
              onChange={(value) => {
                setShow(value);
                setResetKey((key) => key + 1);
              }}
            />
          }
          questions={
            <>
              <PreviewToggle
                tag="Q25"
                label="Paused schedules"
                value={oneList}
                options={[
                  { value: "list", label: "In one list" },
                  { value: "section", label: "Collapsed section" },
                ]}
                onChange={setOneList}
              />
              <PreviewToggle
                tag="Q26"
                label="Admins can pause and delete others' schedules"
                value={adminsManage}
                options={[
                  { value: "yes", label: "Yes" },
                  { value: "no", label: "No" },
                ]}
                onChange={setAdminsManage}
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
        <PagePreview label="Schedules page preview" height={height}>
          <SchedulesApp key={`${show}-${resetKey}`} dataState={show} questions={questions} />
        </PagePreview>
      </KitBlock>

      <KitBlock
        title="The schedule sheet"
        description="Two sheets side by side: a schedule whose last run failed, and Maria Chen's schedule as you see it as a workspace admin (flip Q26 above to compare)."
      >
        <div className="grid min-w-0 gap-4 @4xl/kit-section:grid-cols-2">
          <ScheduleSheetDemo scheduleId="sched-aws-cost" questions={questions} />
          <ScheduleSheetDemo
            key={`maria-${adminsManage}`}
            scheduleId="sched-access-review"
            questions={questions}
          />
        </div>
      </KitBlock>
    </KitSection>
  );
}
