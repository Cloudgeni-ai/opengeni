//! Sandbox shapes, and how many ready sandboxes of each a host keeps.

use std::fmt;
use std::str::FromStr;

use serde::{Deserialize, Serialize};

use crate::protocol::{ImageId, SandboxConfig};

/// A sandbox shape: what a memory image fixes, and the image its disk
/// started as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Shape {
    /// Virtual processors.
    pub vcpus: u8,
    /// Guest memory in MiB.
    pub memory_mib: u32,
    /// The image (ADR 19); `None` for the host's base image.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub image: Option<ImageId>,
}

impl Shape {
    /// `vcpus` processors and `memory_mib` of memory, from the base image.
    #[must_use]
    pub const fn new(vcpus: u8, memory_mib: u32) -> Self {
        Self {
            vcpus,
            memory_mib,
            image: None,
        }
    }

    /// The shape of sandboxes created with `config`.
    #[must_use]
    pub fn of(config: &SandboxConfig) -> Self {
        Self {
            vcpus: config.vcpus,
            memory_mib: config.memory_mib,
            image: config.image,
        }
    }

    /// Guest memory in bytes.
    #[must_use]
    pub fn bytes(self) -> u64 {
        u64::from(self.memory_mib) << 20
    }

    /// The `cpu.weight` of a VM of this shape that is not a sandbox yet,
    /// such as a template build or a ready sandbox filling: all its
    /// processors, as a sandbox requesting them all.
    #[must_use]
    pub fn cpu_weight(self) -> u16 {
        u16::from(self.vcpus) * 100
    }

    /// Millicores of processor time such a VM is guaranteed, and books
    /// while its guest runs: what [`Self::cpu_weight`] gives it.
    #[must_use]
    pub fn cpu_millis(self) -> u64 {
        u64::from(self.cpu_weight()) * 10
    }
}

impl fmt::Display for Shape {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}x{}", self.vcpus, self.memory_mib)?;
        match self.image {
            Some(image) => write!(f, "@{image}"),
            None => Ok(()),
        }
    }
}

impl FromStr for Shape {
    type Err = String;

    /// Parses `VCPUSxMEMORY_MIB[@IMAGE]`, such as `2x1024`.
    fn from_str(text: &str) -> Result<Self, String> {
        let (size, image) = match text.split_once('@') {
            Some((size, image)) => (size, Some(image.parse::<ImageId>()?)),
            None => (text, None),
        };
        let (vcpus, memory) = size
            .split_once('x')
            .ok_or_else(|| format!("shape {text:?} is not VCPUSxMEMORY_MIB, such as 2x1024"))?;
        let shape = Self {
            vcpus: vcpus
                .parse()
                .map_err(|error| format!("vcpus in {text:?}: {error}"))?,
            memory_mib: memory
                .parse()
                .map_err(|error| format!("memory in {text:?}: {error}"))?,
            image,
        };
        SandboxConfig::new(
            shape.vcpus,
            shape.memory_mib,
            crate::protocol::SleepConfig::default(),
        )
        .validate()
        .map(|_| shape)
    }
}

/// A shape and how many ready sandboxes of it to keep, written
/// `SHAPE[:READY]` such as `1x512:16`. Without `:READY`, none: new
/// sandboxes of the shape restore its template.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Keep {
    /// The shape, whose template is built as soon as the agent starts.
    pub shape: Shape,
    /// How many sandboxes of it to keep restored, warm and paused.
    pub ready: u32,
}

impl FromStr for Keep {
    type Err = String;

    fn from_str(text: &str) -> Result<Self, String> {
        let (shape, ready) = match text.split_once(':') {
            Some((shape, ready)) => (
                shape,
                ready
                    .parse()
                    .map_err(|error| format!("ready count in {text:?}: {error}"))?,
            ),
            None => (text, 0),
        };
        Ok(Self {
            shape: shape.parse()?,
            ready,
        })
    }
}
