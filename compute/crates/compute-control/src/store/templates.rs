//! Templates saved from sandboxes ([ADR 22](../../../../docs/adr/0022-templates-saved-from-sandboxes.md)),
//! and the images they keep.
//!
//! A template names a stored sandbox image a host captured from a
//! team's sandbox. The store records every captured image beside the
//! templates, so the images nothing uses any more can be found and
//! forgotten: an image is in use while a template, a sandbox's config or
//! an image built from an OCI image names it. One that stays unused for
//! a while is claimed by one collector, which nothing records a use of
//! from then on, then forgotten in object storage, then its record
//! deleted.

use compute_protocol::host::{Id, ImageId};

/// What a create names as its image to start from a team's template:
/// this, then the template's id or name. The store records a sandbox
/// created from one as this then the template's id.
pub const TEMPLATE_PREFIX: &str = "template/";

/// A team's template.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TemplateRow {
    pub team: String,
    /// Its id, a new sandbox id's text, which creates name it by.
    pub id: String,
    /// The name creates may name it by instead, unique in its team.
    pub name: Option<String>,
    /// The stored image it starts sandboxes from.
    pub image: ImageId,
    /// The sandbox it was captured from.
    pub source: Id,
    /// The shape of that sandbox, which E2B creates from it take; native
    /// creates state their own.
    pub vcpus: u8,
    pub memory_mib: u32,
    /// Its disk's length in MiB, rounded up.
    pub disk_mib: u64,
    pub created_ms: u64,
}

/// How inserting a template went.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Inserted {
    Done,
    /// Its team has a template of that name.
    NameTaken,
    /// Its image is being forgotten in object storage: capture it again
    /// once it is.
    Collecting,
}

/// A collector's claim on the captured images it forgets (see
/// [`crate::store::Store::collect_image`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Collector {
    /// Its own id, which no other collector has.
    pub id: String,
    /// When it claims.
    pub at_ms: u64,
    /// A claim another collector made before this has lapsed: that one
    /// stopped, or is held up, and this takes the image over. Its writes
    /// still in flight are fenced: it checks its claim after reading the
    /// image's pointer, and empties the pointer only on the version read.
    pub lapsed_ms: u64,
}

/// Whether template name `name` is one a create can name: 1 to 64 of
/// letters, digits, `-`, `_` and `.`, starting with a letter or digit.
#[must_use]
pub fn valid_template_name(name: &str) -> bool {
    (1..=64).contains(&name.len())
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

#[cfg(test)]
mod tests {
    use super::valid_template_name;

    #[test]
    fn template_names_are_short_plain_words() {
        for name in ["ci", "ci-warm_2", "node.22", "A"] {
            assert!(valid_template_name(name), "{name}");
        }
        for name in ["", "-ci", ".hidden", "a/b", "has space", &"x".repeat(65)] {
            assert!(!valid_template_name(name), "{name}");
        }
    }
}
