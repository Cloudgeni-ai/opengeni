//! Image references, as `docker pull` reads them:
//! `[registry/]repository[:tag][@digest]`.

use std::fmt;

/// Docker Hub's name in references, and the host its API answers on.
const DOCKER_HUB: &str = "docker.io";
const DOCKER_HUB_API: &str = "registry-1.docker.io";

/// A parsed reference.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Reference {
    /// The registry's host, with its port if it has one.
    pub registry: String,
    pub repository: String,
    /// The tag; `latest` when neither a tag nor a digest is given.
    pub tag: Option<String>,
    /// A manifest digest (`sha256:<hex>`), which wins over the tag.
    pub digest: Option<String>,
}

impl Reference {
    /// Parses `text`.
    pub fn parse(text: &str) -> Result<Self, String> {
        let bad = |why: &str| format!("{text:?} is not an image reference: {why}");
        let (rest, digest) = match text.split_once('@') {
            Some((rest, digest)) => {
                if !valid_digest(digest) {
                    return Err(bad("the digest must be sha256:<64 hex digits>"));
                }
                (rest, Some(digest.to_owned()))
            }
            None => (text, None),
        };
        // A colon after the last slash starts the tag; one before it is a port.
        let last_slash = rest.rfind('/').map_or(0, |at| at + 1);
        let (name, tag) = match rest[last_slash..].find(':') {
            Some(at) => (
                &rest[..last_slash + at],
                Some(rest[last_slash + at + 1..].to_owned()),
            ),
            None => (rest, None),
        };
        if let Some(tag) = &tag
            && !valid_tag(tag)
        {
            return Err(bad("bad tag"));
        }
        let (registry, repository) = match name.split_once('/') {
            Some((first, rest)) if first.contains(['.', ':']) || first == "localhost" => {
                (first.to_owned(), rest.to_owned())
            }
            _ => (DOCKER_HUB.to_owned(), name.to_owned()),
        };
        let repository = if registry == DOCKER_HUB && !repository.contains('/') {
            format!("library/{repository}")
        } else {
            repository
        };
        if repository.is_empty() || !repository.split('/').all(valid_component) {
            return Err(bad("bad repository name"));
        }
        let tag = match (&tag, &digest) {
            (None, None) => Some("latest".to_owned()),
            _ => tag,
        };
        Ok(Self {
            registry,
            repository,
            tag,
            digest,
        })
    }

    /// The host to send API requests to.
    #[must_use]
    pub fn api_host(&self) -> &str {
        if self.registry == DOCKER_HUB {
            DOCKER_HUB_API
        } else {
            &self.registry
        }
    }

    /// What to ask the manifest endpoint for: the digest if there is one.
    #[must_use]
    pub fn manifest_reference(&self) -> &str {
        self.digest
            .as_deref()
            .or(self.tag.as_deref())
            .unwrap_or("latest")
    }
}

impl fmt::Display for Reference {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}/{}", self.registry, self.repository)?;
        if let Some(tag) = &self.tag {
            write!(f, ":{tag}")?;
        }
        if let Some(digest) = &self.digest {
            write!(f, "@{digest}")?;
        }
        Ok(())
    }
}

/// Whether `digest` is `sha256:` and 64 lowercase hex digits, the only
/// algorithm this builder checks.
#[must_use]
pub fn valid_digest(digest: &str) -> bool {
    digest.strip_prefix("sha256:").is_some_and(|hex| {
        hex.len() == 64
            && hex
                .bytes()
                .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    })
}

fn valid_tag(tag: &str) -> bool {
    !tag.is_empty()
        && tag.len() <= 128
        && tag
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"_.-".contains(&b))
        && !tag.starts_with(['.', '-'])
}

fn valid_component(component: &str) -> bool {
    component
        .bytes()
        .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
        && component
            .bytes()
            .next()
            .is_some_and(|b| b.is_ascii_alphanumeric())
}

#[cfg(test)]
mod tests {
    use super::*;

    type Parts = (String, String, Option<String>, Option<String>);

    fn parsed(text: &str) -> Parts {
        let r = Reference::parse(text).unwrap();
        (r.registry, r.repository, r.tag, r.digest)
    }

    const DIGEST: &str = "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn docker_hub_names_are_normalised() {
        assert_eq!(
            parsed("alpine"),
            (
                "docker.io".into(),
                "library/alpine".into(),
                Some("latest".into()),
                None
            )
        );
        assert_eq!(parsed("busybox:1.37").2, Some("1.37".into()));
        assert_eq!(parsed("docker.io/library/alpine:3").1, "library/alpine");
        assert_eq!(parsed("someone/tool").1, "someone/tool");
        let alpine = Reference::parse("alpine").unwrap();
        assert_eq!(alpine.api_host(), "registry-1.docker.io");
        assert_eq!(alpine.to_string(), "docker.io/library/alpine:latest");
    }

    #[test]
    fn other_registries_keep_their_host_and_port() {
        assert_eq!(
            parsed("ghcr.io/cloudgeni-ai/opengeni-sandbox:0.20.0"),
            (
                "ghcr.io".into(),
                "cloudgeni-ai/opengeni-sandbox".into(),
                Some("0.20.0".into()),
                None
            )
        );
        assert_eq!(parsed("localhost:5000/x").0, "localhost:5000");
        assert_eq!(parsed("localhost/x:y").0, "localhost");
        assert_eq!(parsed("europe-docker.pkg.dev/p/r/i:t").1, "p/r/i");
        let acr = Reference::parse("example.azurecr.io/a/b").unwrap();
        assert_eq!(acr.api_host(), "example.azurecr.io");
        assert_eq!(acr.manifest_reference(), "latest");
    }

    #[test]
    fn digests_win_over_tags() {
        let pinned = Reference::parse(&format!("alpine:3@{DIGEST}")).unwrap();
        assert_eq!(pinned.manifest_reference(), DIGEST);
        assert_eq!(pinned.tag.as_deref(), Some("3"));
        let bare = Reference::parse(&format!("localhost:5000/x@{DIGEST}")).unwrap();
        assert_eq!((bare.tag, bare.digest.as_deref()), (None, Some(DIGEST)));
    }

    #[test]
    fn refuses_what_is_not_a_reference() {
        for bad in [
            "",
            "Alpine",
            "alpine:",
            "alpine:-x",
            "alpine@sha256:abc",
            "alpine@md5:0123",
            "ghcr.io/",
            "ghcr.io//x",
            "a b",
            "_x",
        ] {
            assert!(Reference::parse(bad).is_err(), "{bad:?}");
        }
    }
}
