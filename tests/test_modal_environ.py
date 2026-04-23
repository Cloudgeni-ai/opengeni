import os
from pathlib import Path

import pytest
from cloud_agent_platform.config import Settings
from cloud_agent_platform.modal_environ import apply_modal_client_environ


def test_apply_modal_environ_sets_modal_vars(monkeypatch: pytest.MonkeyPatch) -> None:
    for key in ("MODAL_TOKEN_ID", "MODAL_TOKEN_SECRET", "MODAL_PROFILE", "MODAL_CONFIG_PATH"):
        monkeypatch.delenv(key, raising=False)

    apply_modal_client_environ(
        Settings(
            environment="test",
            modal_token_id="ak-test",
            modal_token_secret="as-test",
            modal_profile="p1",
            modal_config_path=Path("/tmp/modal.toml"),
        )
    )
    assert os.environ["MODAL_TOKEN_ID"] == "ak-test"
    assert os.environ["MODAL_TOKEN_SECRET"] == "as-test"
    assert os.environ["MODAL_PROFILE"] == "p1"
    assert os.environ["MODAL_CONFIG_PATH"] == "/tmp/modal.toml"


def test_settings_requires_token_id_and_secret_together() -> None:
    with pytest.raises(ValueError, match="modal_token"):
        Settings(environment="test", modal_token_id="ak", modal_token_secret="")
    with pytest.raises(ValueError, match="modal_token"):
        Settings(environment="test", modal_token_id="", modal_token_secret="as")
    s = Settings(environment="test", modal_token_id="ak", modal_token_secret="as")
    assert s.modal_token_id == "ak"
    assert s.modal_token_secret == "as"
