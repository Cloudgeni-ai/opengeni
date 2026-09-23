# Native infrastructure

Read this only when selecting or troubleshooting the no-Docker path. The
checkout's `scripts/dev-native-infra.sh`, `scripts/dev-stack-backend.sh`, and
`docs/local-development.md` define its current requirements. Linux is the
straightforward native path; do not assume every Linux utility exists on macOS.

## Install before launching

`OPENGENI_DEV_BACKEND=native` starts native processes but does not install their
executables. Provide these for the current OS and CPU:

| Dependency | Check |
| --- | --- |
| PostgreSQL with pgvector | `pg_config`, `psql`, `pg_isready`, and `initdb`/`pg_ctl` in `pg_config --bindir`; the vector extension must match the server major version |
| NATS server | `nats-server` |
| Temporal CLI with development server | `temporal` |
| MinIO server and client | `minio` and `mc` |
| Process utilities used by the native helper | Inspect its `require_command` calls, including `setsid`; also check `sha256sum` |

Use distribution packages for PostgreSQL and its matching pgvector extension
when available. Package installation may start a system PostgreSQL cluster;
leave it alone and let OpenGeni choose a free port for its own cluster.
PostgreSQL cannot initialize a cluster as root; run the launcher as a regular
user where possible. The helper has a separate system-postgres-user path for
root environments.

For NATS and Temporal, use official upstream releases/installers and verify the
installed executables are on the launch shell's PATH. An installer reporting
success does not mean its destination is on PATH.

## MinIO download failures

The ordinary `dl.min.io` binary URLs may return HTTP 410. Do not save an error
page as an executable or repeatedly retry a removed endpoint. Inspect the
checkout's `docker-compose.yml` for its MinIO/mc fixture tags, then look for the
corresponding platform binaries and SHA256 assets in the official
[MinIO releases](https://github.com/minio/minio/releases) and
[mc releases](https://github.com/minio/mc/releases). GitHub's release API can
list asset names and download URLs without a GitHub login.

Check HTTP success, verify the downloaded binary against the upstream checksum,
and run its version command before installing it. Match OS and architecture;
do not assume the newest release still contains binaries. If no verified
compatible native asset is available, explain the blocker and consider the
documented Docker path instead of an arbitrary third-party mirror.

## Launch and recover

Select `OPENGENI_DEV_BACKEND=native` in this checkout's `.env` or launch
environment, then use `bun run dev`. The launcher selects MinIO and converts a
copied Docker sandbox default to `local`; explicit remote sandbox settings are
preserved. Do not manually assign all service ports or start a second stack.

On a small machine, monitor available memory, swap, and actual OOM evidence.
Reduce competing work or explain a resource adjustment if needed; swap is not
a substitute for claiming untested resource requirements. If swap is added,
state whether it survives reboot. Native service logs and process state live
under `.opengeni/native/`; inspect the relevant service on startup failure.
