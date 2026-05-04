"""Map platform settings into the env vars the official `modal` client reads."""

import os

from infra_agent_platform.config import Settings


def apply_modal_client_environ(settings: Settings) -> None:
    """Set ``MODAL_*`` in the process environment from ``INFRA_AGENT_MODAL_*`` in ``Settings``.

    The Modal Python client reads ``MODAL_TOKEN_ID`` and ``MODAL_TOKEN_SECRET`` (they take
    precedence over ``~/.modal.toml``), plus optional ``MODAL_PROFILE`` and
    ``MODAL_CONFIG_PATH`` for config file location and profile name.
    """
    if settings.modal_token_id is not None:
        os.environ["MODAL_TOKEN_ID"] = settings.modal_token_id
    if settings.modal_token_secret is not None:
        os.environ["MODAL_TOKEN_SECRET"] = settings.modal_token_secret
    if settings.modal_profile is not None:
        os.environ["MODAL_PROFILE"] = settings.modal_profile
    if settings.modal_config_path is not None:
        os.environ["MODAL_CONFIG_PATH"] = str(settings.modal_config_path)
