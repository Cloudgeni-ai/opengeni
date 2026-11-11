//! What GitHub's runner scale set API sends and answers, as the actions
//! service speaks it (the same as GitHub's `actions/scaleset` client).

use serde::{Deserialize, Serialize};

/// A label of a scale set.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Label {
    #[serde(rename = "type", default)]
    pub kind: String,
    pub name: String,
}

impl Label {
    /// A label workflows can name in `runs-on`.
    #[must_use]
    pub fn system(name: &str) -> Self {
        Self {
            kind: "System".into(),
            name: name.into(),
        }
    }
}

/// How a scale set's runners behave.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerSetting {
    /// Runners never update themselves: the image pins their version.
    #[serde(default)]
    pub disable_update: bool,
}

/// A runner scale set.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScaleSet {
    #[serde(default, skip_serializing_if = "is_zero")]
    pub id: u64,
    pub name: String,
    pub runner_group_id: u64,
    #[serde(default)]
    pub labels: Vec<Label>,
    #[serde(rename = "RunnerSetting", default)]
    pub runner_setting: RunnerSetting,
}

#[allow(clippy::trivially_copy_pass_by_ref)]
fn is_zero(value: &u64) -> bool {
    *value == 0
}

/// A page of a list the actions service answers.
#[derive(Debug, Deserialize)]
pub struct List<T> {
    #[serde(default)]
    pub count: usize,
    #[serde(default = "Vec::new")]
    pub value: Vec<T>,
}

/// A runner group.
#[derive(Debug, Deserialize)]
pub struct RunnerGroup {
    pub id: u64,
}

/// How many jobs and runners a scale set has, as GitHub counts them.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statistics {
    #[serde(default)]
    pub total_available_jobs: u32,
    #[serde(default)]
    pub total_acquired_jobs: u32,
    #[serde(default)]
    pub total_assigned_jobs: u32,
    #[serde(default)]
    pub total_running_jobs: u32,
    #[serde(default)]
    pub total_registered_runners: u32,
    #[serde(default)]
    pub total_busy_runners: u32,
    #[serde(default)]
    pub total_idle_runners: u32,
}

/// A message session: where the scale set's messages are fetched, and
/// with what token.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub session_id: String,
    pub message_queue_url: String,
    pub message_queue_access_token: String,
    #[serde(default)]
    pub statistics: Option<Statistics>,
}

/// A message as the queue answers it: its jobs are a JSON array in a
/// string.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RawMessage {
    pub message_id: u64,
    pub message_type: String,
    #[serde(default)]
    pub body: String,
    #[serde(default)]
    pub statistics: Option<Statistics>,
}

/// One job event in a message.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JobEvent {
    pub message_type: String,
    #[serde(default)]
    pub runner_request_id: i64,
    #[serde(default)]
    pub runner_name: Option<String>,
    #[serde(default)]
    pub runner_id: Option<i64>,
    #[serde(default)]
    pub result: Option<String>,
    #[serde(default)]
    pub repository_name: Option<String>,
    #[serde(default)]
    pub job_display_name: Option<String>,
}

/// A message, decoded.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Message {
    pub id: u64,
    pub statistics: Option<Statistics>,
    pub jobs: Vec<JobEvent>,
}

impl Message {
    /// Decodes a message the queue answered; only job messages are known.
    pub fn decode(raw: &RawMessage) -> Result<Self, String> {
        if raw.message_type != "RunnerScaleSetJobMessages" {
            return Err(format!("unknown message type {:?}", raw.message_type));
        }
        let jobs = if raw.body.trim().is_empty() {
            Vec::new()
        } else {
            serde_json::from_str(&raw.body).map_err(|error| format!("message body: {error}"))?
        };
        Ok(Self {
            id: raw.message_id,
            statistics: raw.statistics,
            jobs,
        })
    }

    /// The request ids of the jobs it offers.
    #[must_use]
    pub fn available(&self) -> Vec<i64> {
        self.of("JobAvailable")
            .map(|job| job.runner_request_id)
            .collect()
    }

    /// Its events of one kind.
    pub fn of<'a>(&'a self, kind: &'a str) -> impl Iterator<Item = &'a JobEvent> + 'a {
        self.jobs.iter().filter(move |job| job.message_type == kind)
    }
}

/// What `generatejitconfig` is asked.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct JitSetting<'a> {
    pub name: &'a str,
    pub work_folder: &'a str,
}

/// A runner GitHub knows.
#[derive(Clone, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunnerRef {
    pub id: u64,
    pub name: String,
    /// The scale set it was registered in, as the actions service says
    /// when asked about it by name.
    #[serde(default)]
    pub runner_scale_set_id: Option<u64>,
}

/// A just-in-time runner: registered already, and the configuration that
/// starts it.
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct JitConfig {
    pub runner: RunnerRef,
    #[serde(rename = "encodedJITConfig")]
    pub encoded_jit_config: String,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_message_carries_its_jobs_in_a_string() {
        let raw: RawMessage = serde_json::from_str(
            r#"{"messageId":7,"messageType":"RunnerScaleSetJobMessages",
                "body":"[{\"messageType\":\"JobAvailable\",\"runnerRequestId\":11},{\"messageType\":\"JobCompleted\",\"runnerRequestId\":9,\"runnerName\":\"p-1\",\"runnerId\":3,\"result\":\"succeeded\"}]",
                "statistics":{"totalAssignedJobs":2,"totalRunningJobs":1}}"#,
        )
        .unwrap();
        let message = Message::decode(&raw).unwrap();
        assert_eq!(message.id, 7);
        assert_eq!(message.available(), [11]);
        let completed: Vec<_> = message.of("JobCompleted").collect();
        assert_eq!(completed[0].runner_name.as_deref(), Some("p-1"));
        assert_eq!(message.statistics.unwrap().total_assigned_jobs, 2);
    }

    #[test]
    fn an_empty_body_has_no_jobs_and_other_types_are_refused() {
        let raw = |kind: &str, body: &str| RawMessage {
            message_id: 1,
            message_type: kind.into(),
            body: body.into(),
            statistics: None,
        };
        let quiet = Message::decode(&raw("RunnerScaleSetJobMessages", "")).unwrap();
        assert_eq!(quiet.jobs.len(), 0);
        assert!(Message::decode(&raw("Something", "[]")).is_err());
        assert!(Message::decode(&raw("RunnerScaleSetJobMessages", "{")).is_err());
    }

    #[test]
    fn a_scale_set_is_written_as_the_service_reads_it() {
        let set = ScaleSet {
            id: 0,
            name: "ci".into(),
            runner_group_id: 1,
            labels: vec![Label::system("ci"), Label::system("linux")],
            runner_setting: RunnerSetting {
                disable_update: true,
            },
        };
        let json = serde_json::to_value(&set).unwrap();
        assert!(json.get("id").is_none());
        assert_eq!(json["runnerGroupId"], 1);
        assert_eq!(json["labels"][1]["type"], "System");
        assert_eq!(json["RunnerSetting"]["disableUpdate"], true);
    }
}
