import base64
import hashlib
import hmac
import ipaddress
import json
import secrets
import time
from typing import Any
from urllib.parse import urlparse

STATE_MAX_AGE_SECONDS = 60 * 60


def build_github_app_manifest(
    *,
    app_name: str,
    base_url: str,
    public: bool,
    include_ci_permissions: bool,
) -> dict[str, Any]:
    base = base_url.rstrip("/")
    permissions: dict[str, str] = {
        "metadata": "read",
        "contents": "write",
        "pull_requests": "write",
    }
    events = ["pull_request", "push"]
    if include_ci_permissions:
        permissions.update(
            {
                "actions": "read",
                "checks": "read",
                "statuses": "write",
            }
        )
        events.extend(["check_run", "workflow_run"])

    manifest = {
        "name": app_name,
        "url": base,
        "redirect_url": f"{base}/v1/github/app-manifest/callback",
        "public": public,
        "request_oauth_on_install": False,
        "default_permissions": permissions,
    }
    if _public_https_url(base):
        manifest["hook_attributes"] = {
            "url": f"{base}/v1/github/webhook",
            "active": True,
        }
        manifest["default_events"] = events
    return manifest


def personal_app_manifest_url(state: str) -> str:
    return f"https://github.com/settings/apps/new?state={state}"


def organization_app_manifest_url(*, organization: str, state: str) -> str:
    return f"https://github.com/organizations/{organization}/settings/apps/new?state={state}"


def create_signed_state(secret: str, *, now: int | None = None) -> str:
    payload = {
        "nonce": secrets.token_urlsafe(16),
        "iat": int(time.time() if now is None else now),
    }
    encoded_payload = _base64url_encode(json.dumps(payload, separators=(",", ":")).encode())
    signature = _sign_state_payload(encoded_payload, secret)
    return f"{encoded_payload}.{signature}"


def verify_signed_state(state: str, secret: str, *, now: int | None = None) -> bool:
    parts = state.split(".", 1)
    if len(parts) != 2:
        return False
    encoded_payload, signature = parts
    expected = _sign_state_payload(encoded_payload, secret)
    if not hmac.compare_digest(signature, expected):
        return False
    try:
        payload = json.loads(_base64url_decode(encoded_payload).decode())
    except (ValueError, UnicodeDecodeError):
        return False
    iat = payload.get("iat")
    if not isinstance(iat, int):
        return False
    current_time = int(time.time() if now is None else now)
    return 0 <= current_time - iat <= STATE_MAX_AGE_SECONDS


def env_lines_from_github_manifest_conversion(payload: dict[str, Any]) -> list[str]:
    private_key = str(payload.get("pem") or "").replace("\n", "\\n")
    return [
        f"INFRA_AGENT_GITHUB_APP_ID={payload.get('id') or ''}",
        f"INFRA_AGENT_GITHUB_CLIENT_ID={payload.get('client_id') or ''}",
        f"INFRA_AGENT_GITHUB_CLIENT_SECRET={payload.get('client_secret') or ''}",
        f"INFRA_AGENT_GITHUB_APP_SLUG={payload.get('slug') or ''}",
        f"INFRA_AGENT_GITHUB_WEBHOOK_SECRET={payload.get('webhook_secret') or ''}",
        f'INFRA_AGENT_GITHUB_APP_PRIVATE_KEY="{private_key}"',
    ]


def _public_https_url(url: str) -> bool:
    parsed = urlparse(url)
    if parsed.scheme != "https" or not parsed.hostname:
        return False
    host = parsed.hostname.lower()
    if host == "localhost" or host.endswith(".localhost"):
        return False
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return True
    return address.is_global


def _sign_state_payload(encoded_payload: str, secret: str) -> str:
    digest = hmac.new(secret.encode(), encoded_payload.encode(), hashlib.sha256).digest()
    return _base64url_encode(digest)


def _base64url_encode(value: bytes) -> str:
    return base64.urlsafe_b64encode(value).decode().rstrip("=")


def _base64url_decode(value: str) -> bytes:
    padding = "=" * (-len(value) % 4)
    return base64.urlsafe_b64decode(value + padding)
