# Sandbox images and the guest

A sandbox image is any OCI image turned into an ext4 file, with our init
and E2B's envd added ([ADR 19](../docs/adr/0019-e2b-compatible-front-door-and-guest-init.md)).

```sh
OUT=~/guest-out guest/build.sh          # compute-guest, envd and bash
compute-host build-image alpine:3.20 --guest ~/guest-out \
  --output alpine.ext4 --store gs://bucket/prefix
compute-host create <id> --image <the printed image id>
```

## What a build does

1. Pulls the image for linux/amd64 from its registry, anonymously or with
   `--registry-user` and `REGISTRY_TOKEN`, and checks every blob's digest.
2. Applies the layers in order into a directory: whiteouts, opaque
   directories, owners, modes, extended attributes, hard links and device
   nodes, each layer checked against the image's `diff_ids`.
3. Adds `/opengeni/init` (compute-guest), `/opengeni/envd` and
   `/opengeni/image.json` (the image's user, directory, environment,
   entrypoint and command), points `/sbin/init` at our init, adds a static
   bash at `/bin/bash` if the image has none, and the `user` account (uid
   1000, home `/home/user`) if there is none.
4. Makes an ext4 file of it with `mkfs.ext4 -d`: the contents plus an
   eighth and 256 MiB, plus `--free-gib` (default 4) of room, at least
   6 GiB; sparse, so unused room costs nothing.
5. Names it by the BLAKE3 digest of the file, its image id, and with
   `--store` stores it as content-named chunks under a pointer
   `rootfs-<id>` (or as `rootfs/<id>.ext4` in a directory store).

A host that gets a create naming an image it does not have fetches it from
its store once, however many creates wait for it, checks it against its id,
and keeps it under `<root>/rootfs/`. It first asks the store for the file's
length and books that much disk, so the fetch never takes room a save
needs; a host without the room refuses the creates with `host_full`. New
disks are copies of it. Templates are per image and shape. An image no
create used for as long as a template may go unused, and whose template is
gone, is removed.

## What the guest does

`compute-guest` is PID 1. It mounts the basics, sets up the network from
the kernel's `ip=` argument, sets the hostname and machine id from the
sandbox id, starts envd (`-isnotfc -port 49983`) and keeps it running,
runs the image's command once under the image's user, reaps orphans, and
on SIGTERM, SIGINT or SIGPWR (or Ctrl-Alt-Del) ends every process, syncs,
remounts the root read-only and ends the VM.

The host reaches it only through vsock:

| Port | What |
| --- | --- |
| 53 | Restore notices, as with the lab image: time, sandbox id, seed. Answered only once envd took its `/init` with the new time. |
| 54 | Accepts connections once envd answered and took its first `/init`. Templates wait on it. |
| 57 | The gateway. A stream starts with one line: `tcp <port>` relays to that port on the guest's loopback (envd is 49983), answered `ok`; `init <json>` gives the sandbox its environment, access token, default user and directory, answered `ok` once envd took them, or `error <reason>`. |

envd replaces its environment on every `/init` and refuses one without the
token once it has one, so the guest keeps what the sandbox was given, in
`/opengeni/init-data.json` (mode 0600), and sends all of it each time:
after boot, after every restore and after envd restarts. A sandbox cloned
from a template is given its own with `init` before anyone can reach it.

envd runs with `-isnotfc`: it reads nothing from Firecracker's metadata
service, and its own `E2B_SANDBOX` variable is `false`.
