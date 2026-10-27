//! GitHub Actions runner pools on Opengeni compute
//! ([ADR 23](../../../docs/adr/0023-github-actions-runner-pools.md)): a
//! scale set whose every job runs in a fresh sandbox, started from a
//! template kept warm from the default branch, with a build cache in
//! object storage.

pub mod cache;
pub mod compute;
pub mod github;
pub mod pool;
pub mod warm;
