#!/usr/bin/env python3
"""Materialize [ingress.secure_access] for OpenSandbox server v0.2.2.

Official server v0.2.2 reads signing keys only from config.toml. The Helm chart
injects OPENSANDBOX_SECURE_ACCESS_* from Secret `opensandbox-secure-access`,
but that image ignores those env vars. This helper copies the mounted TOML to a
writable runtime path and appends the OSEP-0011 block from env so keys never
enter git or the server ConfigMap.

Never prints key material.
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

DEFAULT_SOURCE = "/etc/opensandbox/config.toml"
DEFAULT_DEST = "/runtime-config/config.toml"
KEYS_ENV = "OPENSANDBOX_SECURE_ACCESS_KEYS"
ACTIVE_ENV = "OPENSANDBOX_SECURE_ACCESS_ACTIVE_KEY"


def toml_string(value: str) -> str:
    return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'


def parse_key_ring(keys_env: str) -> list[tuple[str, str]]:
    entries: list[tuple[str, str]] = []
    for raw in keys_env.split(","):
        pair = raw.strip()
        if not pair:
            continue
        key_id, sep, secret = pair.partition("=")
        if not sep or not key_id.strip():
            raise ValueError("key ring entries must be key_id=base64")
        entries.append((key_id.strip(), secret.strip()))
    if not entries:
        raise ValueError("key ring is empty")
    return entries


def render_secure_access_toml(active_key: str, entries: list[tuple[str, str]]) -> str:
    lines = ["", "[ingress.secure_access]", f"active_key = {toml_string(active_key)}"]
    for key_id, secret in entries:
        lines.extend(
            [
                "[[ingress.secure_access.keys]]",
                f"key_id = {toml_string(key_id)}",
                f"key = {toml_string(secret)}",
            ]
        )
    return "\n".join(lines) + "\n"


def materialize(
    source_text: str,
    keys_env: str | None,
    active_env: str | None,
) -> str:
    if keys_env is None and active_env is None:
        return source_text if source_text.endswith("\n") else source_text + "\n"
    if not keys_env or not active_env:
        raise ValueError(f"{KEYS_ENV} and {ACTIVE_ENV} must be set together")
    if "[ingress.secure_access]" in source_text:
        raise ValueError("config already contains [ingress.secure_access]; refusing to duplicate")
    block = render_secure_access_toml(active_env.strip(), parse_key_ring(keys_env))
    return source_text.rstrip() + "\n" + block


def main() -> int:
    source = Path(os.environ.get("SANDBOX_CONFIG_PATH", DEFAULT_SOURCE))
    dest = Path(os.environ.get("OPENSANDBOX_RUNTIME_CONFIG_PATH", DEFAULT_DEST))
    try:
        rendered = materialize(
            source.read_text(encoding="utf-8"),
            os.environ.get(KEYS_ENV),
            os.environ.get(ACTIVE_ENV),
        )
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(rendered, encoding="utf-8")
    except Exception as error:  # noqa: BLE001 — fail closed, no key material
        print(f"secure-access runtime config failed: {error}", file=sys.stderr)
        return 1
    print("secure-access runtime config materialized", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
