"""Run the pinned upstream XMCP server with unattended static OAuth1 tokens."""

import os

from oauthlib.oauth1 import Client as OAuth1Client

import server as upstream_server


def _required_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"XMCP requires {name} for unattended startup.")
    return value


def _oauth1_client() -> OAuth1Client:
    consumer_key = _required_env("X_OAUTH_CONSUMER_KEY")
    consumer_secret = _required_env("X_OAUTH_CONSUMER_SECRET")
    bearer_token = _required_env("X_BEARER_TOKEN")
    access_token = _required_env("X_OAUTH_ACCESS_TOKEN")
    access_token_secret = _required_env("X_OAUTH_ACCESS_TOKEN_SECRET")
    # The upstream request path uses OAuth1 signing. Keep the bearer token in
    # the required deployment contract as well because X treats it as the
    # app-level credential and the official server documents it as required.
    del bearer_token
    return OAuth1Client(
        client_key=consumer_key,
        client_secret=consumer_secret,
        resource_owner_key=access_token,
        resource_owner_secret=access_token_secret,
        signature_type="AUTH_HEADER",
    )


# The upstream server resolves this function when it builds the HTTP client.
# Replacing only that seam preserves its OpenAPI-to-FastMCP behavior while
# avoiding a browser callback inside Kubernetes.
upstream_server.build_oauth1_client = _oauth1_client
upstream_server.main()