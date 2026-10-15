# Opengeni compute

Durable sandboxes that sleep when idle and wake on demand, on hosts we run
ourselves. Each sandbox is a small hardware-isolated VM. It keeps its files
and running programs across sleep and costs almost nothing while asleep.

Status: design and prototype phase. Nothing here is used by Opengeni yet.

## Layout

| Path | What it is |
| --- | --- |
| `crates/` | Rust crates; each joins the workspace automatically |
| `lab/` | Throwaway measurement harness (Bun scripts) used to size the design |

## Building

The crates target Linux hosts with KVM. Build and test on Linux:

```sh
cargo test --workspace
```
