//! Wide events: one record holding everything about one thing that
//! happened.

use std::borrow::Cow;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use super::TraceContext;

/// How serious an event is, as OpenTelemetry severity numbers name it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord)]
pub enum Severity {
    /// Something happened as it should.
    Info,
    /// Something failed and is retried or recovered from.
    Warn,
    /// Something that must never happen did: a zero alarm.
    Error,
}

impl Severity {
    /// The OpenTelemetry severity number.
    #[must_use]
    pub fn number(self) -> u8 {
        match self {
            Self::Info => 9,
            Self::Warn => 13,
            Self::Error => 17,
        }
    }

    /// The OpenTelemetry severity text.
    #[must_use]
    pub fn text(self) -> &'static str {
        match self {
            Self::Info => "INFO",
            Self::Warn => "WARN",
            Self::Error => "ERROR",
        }
    }
}

/// An attribute's value.
#[derive(Clone, Debug, PartialEq)]
pub enum Value {
    /// Text.
    Str(Cow<'static, str>),
    /// A whole number.
    Int(i64),
    /// A truth value.
    Bool(bool),
}

impl From<&'static str> for Value {
    fn from(text: &'static str) -> Self {
        Self::Str(Cow::Borrowed(text))
    }
}

impl From<String> for Value {
    fn from(text: String) -> Self {
        Self::Str(Cow::Owned(text))
    }
}

impl From<bool> for Value {
    fn from(value: bool) -> Self {
        Self::Bool(value)
    }
}

impl From<u64> for Value {
    /// Saturates at `i64::MAX`, which no count or duration here reaches.
    fn from(value: u64) -> Self {
        Self::Int(i64::try_from(value).unwrap_or(i64::MAX))
    }
}

impl From<u32> for Value {
    fn from(value: u32) -> Self {
        Self::Int(i64::from(value))
    }
}

impl From<Duration> for Value {
    /// Whole microseconds.
    fn from(value: Duration) -> Self {
        Self::from(u64::try_from(value.as_micros()).unwrap_or(u64::MAX))
    }
}

/// One wide event: its name, when it happened, and every attribute that
/// describes it.
#[derive(Clone, Debug, PartialEq)]
pub struct Event {
    /// What kind of event, such as `compute.step`.
    pub name: &'static str,
    /// When, in nanoseconds since the Unix epoch.
    pub unix_nanos: u64,
    /// How serious.
    pub severity: Severity,
    /// The caller's trace, if a traced request caused it.
    pub trace: Option<TraceContext>,
    /// Everything else, under OpenTelemetry semantic-convention names or
    /// `compute.*` ones.
    pub attributes: Vec<(Cow<'static, str>, Value)>,
}

/// Nanoseconds since the Unix epoch now.
#[must_use]
pub fn unix_nanos_now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |since| {
            u64::try_from(since.as_nanos()).unwrap_or(u64::MAX)
        })
}

impl Event {
    /// An event named `name` happening now.
    #[must_use]
    pub fn new(name: &'static str, severity: Severity) -> Self {
        Self {
            name,
            unix_nanos: unix_nanos_now(),
            severity,
            trace: None,
            attributes: Vec::with_capacity(16),
        }
    }

    /// Adds an attribute.
    #[must_use]
    pub fn with(mut self, key: impl Into<Cow<'static, str>>, value: impl Into<Value>) -> Self {
        self.push(key, value);
        self
    }

    /// Adds an attribute in place.
    pub fn push(&mut self, key: impl Into<Cow<'static, str>>, value: impl Into<Value>) {
        self.attributes.push((key.into(), value.into()));
    }

    /// Adds an attribute when there is a value; an absent value is left
    /// out, never written as zero.
    #[must_use]
    pub fn with_some<V: Into<Value>>(
        self,
        key: impl Into<Cow<'static, str>>,
        value: Option<V>,
    ) -> Self {
        match value {
            Some(value) => self.with(key, value),
            None => self,
        }
    }

    /// Attaches the caller's trace.
    #[must_use]
    pub fn traced(mut self, trace: Option<TraceContext>) -> Self {
        self.trace = trace;
        self
    }

    /// The value of attribute `key`, if set.
    #[must_use]
    pub fn get(&self, key: &str) -> Option<&Value> {
        self.attributes
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    /// The event as one JSON object on one line, for the local journal.
    #[must_use]
    pub fn to_json_line(&self) -> String {
        let mut object = serde_json::Map::with_capacity(self.attributes.len() + 4);
        object.insert("event".into(), self.name.into());
        object.insert("severity".into(), self.severity.text().into());
        object.insert("time_unix_nano".into(), self.unix_nanos.into());
        if let Some(trace) = &self.trace {
            object.insert("trace_id".into(), trace.trace_hex().into());
            object.insert("span_id".into(), trace.span_hex().into());
        }
        for (key, value) in &self.attributes {
            let value = match value {
                Value::Str(text) => serde_json::Value::from(text.as_ref()),
                Value::Int(number) => serde_json::Value::from(*number),
                Value::Bool(truth) => serde_json::Value::from(*truth),
            };
            object.insert(key.to_string(), value);
        }
        serde_json::Value::Object(object).to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn absent_values_are_left_out_and_lines_carry_the_trace() {
        let trace = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
            .parse()
            .ok();
        let event = Event::new("compute.step", Severity::Info)
            .with("compute.step", "restore")
            .with_some("compute.pressure.some_us", None::<u64>)
            .with("compute.duration_us", Duration::from_millis(3))
            .traced(trace);
        assert!(event.get("compute.pressure.some_us").is_none());
        let line: serde_json::Value = serde_json::from_str(&event.to_json_line()).unwrap();
        assert_eq!(line["event"], "compute.step");
        assert_eq!(line["compute.duration_us"], 3000);
        assert_eq!(line["trace_id"], "4bf92f3577b34da6a3ce929d0e0e4736");
        assert!(line.get("compute.pressure.some_us").is_none());
    }
}
