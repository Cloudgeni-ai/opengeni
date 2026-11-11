//! E2B's REST API on the wire: the bodies its JS SDK 2.56.0 sends and the
//! answers it reads, with the names E2B's API specification gives them.
//!
//! Bodies accept fields Opengeni compute leaves out (MCP, IAM, volumes, egress
//! rules) only when they ask for nothing: a request that needs one is
//! refused rather than silently getting less than it asked for.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

/// `POST /v2/sandboxes`.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewSandbox {
    #[serde(rename = "templateID")]
    pub template_id: String,
    /// Seconds.
    #[serde(default)]
    pub timeout: Option<u64>,
    /// Pause rather than kill at the timeout.
    #[serde(default)]
    pub auto_pause: Option<bool>,
    /// Keep memory when pausing at the timeout; only `true` is offered.
    #[serde(default)]
    pub auto_pause_memory: Option<bool>,
    #[serde(default)]
    pub auto_resume: Option<AutoResume>,
    /// Deprecated by E2B; every sandbox here is secured.
    #[serde(default)]
    pub secure: Option<bool>,
    #[serde(default, rename = "allow_internet_access")]
    pub allow_internet_access: Option<bool>,
    #[serde(default)]
    pub network: Option<Network>,
    #[serde(default)]
    pub metadata: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub env_vars: Option<BTreeMap<String, String>>,
    #[serde(default)]
    pub mcp: Option<serde_json::Value>,
    #[serde(default)]
    pub iam: Option<serde_json::Value>,
    #[serde(default)]
    pub volume_mounts: Option<Vec<serde_json::Value>>,
}

/// Whether traffic resumes a paused sandbox.
#[derive(Clone, Copy, Debug, Default, Deserialize, Serialize)]
pub struct AutoResume {
    pub enabled: bool,
}

/// A sandbox's network settings. Only public traffic is offered.
#[derive(Debug, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Network {
    #[serde(default)]
    pub allow_public_traffic: Option<bool>,
    #[serde(default)]
    pub allow_out: Option<Vec<String>>,
    #[serde(default)]
    pub deny_out: Option<Vec<String>>,
    #[serde(default)]
    pub rules: Option<serde_json::Value>,
    #[serde(default)]
    pub egress_proxy: Option<serde_json::Value>,
    #[serde(default)]
    pub mask_request_host: Option<String>,
}

fn asks_for(value: Option<&serde_json::Value>) -> bool {
    match value {
        None | Some(serde_json::Value::Null) => false,
        Some(serde_json::Value::Object(map)) => !map.is_empty(),
        Some(serde_json::Value::Array(list)) => !list.is_empty(),
        Some(_) => true,
    }
}

impl NewSandbox {
    /// Refuses what Opengeni compute leaves out, naming it.
    ///
    /// # Errors
    ///
    /// When the request asks for something not offered.
    pub fn refuse_unoffered(&self) -> Result<(), String> {
        let mut asked = Vec::new();
        if asks_for(self.mcp.as_ref()) {
            asked.push("mcp");
        }
        if asks_for(self.iam.as_ref()) {
            asked.push("iam");
        }
        if self
            .volume_mounts
            .as_ref()
            .is_some_and(|list| !list.is_empty())
        {
            asked.push("volumeMounts");
        }
        if self.allow_internet_access == Some(false) {
            asked.push("allow_internet_access: false");
        }
        if self.auto_pause_memory == Some(false) {
            asked.push("autoPauseMemory: false");
        }
        if let Some(network) = &self.network {
            if network
                .allow_out
                .as_ref()
                .is_some_and(|list| !list.is_empty())
                || network
                    .deny_out
                    .as_ref()
                    .is_some_and(|list| !list.is_empty())
                || asks_for(network.rules.as_ref())
                || asks_for(network.egress_proxy.as_ref())
            {
                asked.push("network egress rules");
            }
            if network.mask_request_host.is_some() {
                asked.push("network.maskRequestHost");
            }
        }
        if asked.is_empty() {
            Ok(())
        } else {
            Err(format!("not offered here: {}", asked.join(", ")))
        }
    }
}

/// `POST /v2/sandboxes/{id}/connect`, and the legacy resume.
#[derive(Debug, Default, Deserialize)]
pub struct ConnectSandbox {
    /// Seconds.
    #[serde(default)]
    pub timeout: Option<u64>,
    /// `false` asks to reboot from disk rather than restore memory.
    #[serde(default)]
    pub memory: Option<bool>,
}

/// `POST /sandboxes/{id}/timeout`.
#[derive(Debug, Deserialize)]
pub struct SetTimeout {
    /// Seconds.
    pub timeout: u64,
}

/// `POST /sandboxes/{id}/pause`.
#[derive(Debug, Default, Deserialize)]
pub struct Pause {
    /// `false` asks for a filesystem-only pause.
    #[serde(default)]
    pub memory: Option<bool>,
}

/// `POST /sandboxes/{id}/snapshots`.
#[derive(Debug, Default, Deserialize)]
pub struct NewSnapshot {
    #[serde(default)]
    pub name: Option<String>,
    /// `false` asks for a filesystem snapshot, the only kind offered;
    /// omitted, the SDK asks for one with memory.
    #[serde(default)]
    pub memory: Option<bool>,
}

/// A snapshot, as a create or a list answers it.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Snapshot {
    #[serde(rename = "snapshotID")]
    pub snapshot_id: String,
    pub names: Vec<String>,
}

/// `GET /snapshots`.
#[derive(Debug, Default, Deserialize)]
pub struct ListSnapshots {
    #[serde(default, rename = "sandboxID")]
    pub sandbox_id: Option<String>,
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub limit: Option<usize>,
    #[serde(default, rename = "nextToken")]
    pub next_token: Option<String>,
}

/// The answer to a create or connect.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Sandbox {
    #[serde(rename = "templateID")]
    pub template_id: String,
    #[serde(rename = "sandboxID")]
    pub sandbox_id: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    #[serde(rename = "envdVersion")]
    pub envd_version: String,
    #[serde(rename = "envdAccessToken")]
    pub envd_access_token: String,
    #[serde(rename = "trafficAccessToken")]
    pub traffic_access_token: Option<String>,
    pub domain: Option<String>,
}

/// What a sandbox's timeout does and whether traffic resumes it.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Lifecycle {
    pub auto_resume: bool,
    pub on_timeout: String,
}

/// Its network settings, as reported.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct NetworkView {
    pub allow_public_traffic: bool,
}

/// `GET /sandboxes/{id}`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SandboxDetail {
    #[serde(rename = "templateID")]
    pub template_id: String,
    #[serde(rename = "sandboxID")]
    pub sandbox_id: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub started_at: String,
    pub end_at: String,
    pub envd_version: String,
    pub envd_access_token: String,
    pub allow_internet_access: bool,
    pub domain: Option<String>,
    pub cpu_count: u32,
    #[serde(rename = "memoryMB")]
    pub memory_mb: u32,
    #[serde(rename = "diskSizeMB")]
    pub disk_size_mb: u64,
    pub metadata: BTreeMap<String, String>,
    pub state: String,
    pub network: NetworkView,
    pub lifecycle: Lifecycle,
    /// `full` once a pause finished; omitted otherwise.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pause_mode: Option<String>,
    pub volume_mounts: Vec<serde_json::Value>,
}

/// One sandbox in `GET /v2/sandboxes`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ListedSandbox {
    #[serde(rename = "templateID")]
    pub template_id: String,
    #[serde(rename = "sandboxID")]
    pub sandbox_id: String,
    #[serde(rename = "clientID")]
    pub client_id: String,
    pub started_at: String,
    pub end_at: String,
    pub cpu_count: u32,
    #[serde(rename = "memoryMB")]
    pub memory_mb: u32,
    #[serde(rename = "diskSizeMB")]
    pub disk_size_mb: u64,
    pub metadata: BTreeMap<String, String>,
    pub state: String,
    pub envd_version: String,
    pub volume_mounts: Vec<serde_json::Value>,
}

/// One template in `GET /templates`.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Template {
    #[serde(rename = "templateID")]
    pub template_id: String,
    #[serde(rename = "buildID")]
    pub build_id: String,
    pub cpu_count: u32,
    #[serde(rename = "memoryMB")]
    pub memory_mb: u32,
    #[serde(rename = "diskSizeMB")]
    pub disk_size_mb: u64,
    pub public: bool,
    pub aliases: Vec<String>,
    pub names: Vec<String>,
    pub envd_version: String,
    pub build_status: String,
}

/// An error, as E2B's API answers one.
#[derive(Debug, Serialize, Deserialize, PartialEq, Eq)]
pub struct Error {
    pub code: u16,
    pub message: String,
}

/// A time in milliseconds since the Unix epoch as RFC 3339, in UTC with
/// milliseconds, such as `2026-10-17T15:04:05.123Z`.
#[must_use]
pub fn rfc3339(ms: u64) -> String {
    let seconds = ms / 1000;
    let days = seconds / 86_400;
    let in_day = seconds % 86_400;
    // Howard Hinnant's days-to-civil, for days since 1970-01-01.
    let z = days + 719_468;
    let era = z / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = yoe + era * 400 + u64::from(month <= 2);
    format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        in_day / 3_600,
        in_day % 3_600 / 60,
        in_day % 60,
        ms % 1000
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn times_are_rfc3339_in_utc() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00.000Z");
        assert_eq!(rfc3339(951_782_400_000), "2000-02-29T00:00:00.000Z");
        assert_eq!(rfc3339(1_792_249_445_123), "2026-10-17T15:04:05.123Z");
        assert_eq!(rfc3339(4_102_444_799_999), "2099-12-31T23:59:59.999Z");
    }

    #[test]
    fn the_sdks_create_body_reads() {
        let body: NewSandbox = serde_json::from_str(
            r#"{"templateID":"base","timeout":300,"autoPause":true,"autoPauseMemory":true,
                "autoResume":{"enabled":true},"allow_internet_access":true,
                "network":{"allowPublicTraffic":false},"metadata":{"a":"b"},
                "envVars":{"X":"1"}}"#,
        )
        .unwrap();
        assert_eq!(body.template_id, "base");
        assert_eq!(body.timeout, Some(300));
        assert_eq!(body.auto_pause, Some(true));
        assert!(body.auto_resume.unwrap().enabled);
        assert_eq!(
            body.network.as_ref().unwrap().allow_public_traffic,
            Some(false)
        );
        assert_eq!(body.env_vars.as_ref().unwrap()["X"], "1");
        assert!(body.refuse_unoffered().is_ok());
    }

    #[test]
    fn what_is_not_offered_is_refused_by_name() {
        let body: NewSandbox = serde_json::from_str(
            r#"{"templateID":"base","allow_internet_access":false,
                "network":{"denyOut":["0.0.0.0/0"]},"mcp":{"x":{}}}"#,
        )
        .unwrap();
        let refusal = body.refuse_unoffered().unwrap_err();
        for named in ["mcp", "allow_internet_access", "egress"] {
            assert!(refusal.contains(named), "{refusal}");
        }
        let empty: NewSandbox = serde_json::from_str(
            r#"{"templateID":"base","mcp":null,"network":{"allowOut":[]},"volumeMounts":[]}"#,
        )
        .unwrap();
        assert!(empty.refuse_unoffered().is_ok());
    }

    #[test]
    fn answers_carry_e2bs_names() {
        let answer = serde_json::to_value(Sandbox {
            template_id: "base".into(),
            sandbox_id: "abc".into(),
            client_id: "compute".into(),
            envd_version: "0.10.0".into(),
            envd_access_token: "t".into(),
            traffic_access_token: None,
            domain: Some("example.test".into()),
        })
        .unwrap();
        for key in [
            "templateID",
            "sandboxID",
            "clientID",
            "envdVersion",
            "envdAccessToken",
            "trafficAccessToken",
            "domain",
        ] {
            assert!(answer.get(key).is_some(), "{key} in {answer}");
        }
    }
}
