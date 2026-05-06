import stat
from pathlib import Path


def test_sandbox_image_installs_git_askpass_helper() -> None:
    root = Path(__file__).resolve().parents[1]
    helper = root / "docker" / "infra-agent-git-askpass"
    dockerfile = root / "docker" / "sandbox.Dockerfile"

    helper_text = helper.read_text()
    mode = helper.stat().st_mode

    assert mode & stat.S_IXUSR
    assert "x-access-token" in helper_text
    assert "GH_TOKEN" in helper_text
    assert "GITHUB_TOKEN" in helper_text
    assert "COPY docker/infra-agent-git-askpass" in dockerfile.read_text()


def test_sandbox_image_installs_azure_login_helper() -> None:
    root = Path(__file__).resolve().parents[1]
    helper = root / "docker" / "infra-agent-azure-login"
    dockerfile = root / "docker" / "sandbox.Dockerfile"

    helper_text = helper.read_text()
    mode = helper.stat().st_mode

    assert helper.exists()
    assert mode & stat.S_IXUSR
    assert "AZURE_CLIENT_ID" in helper_text
    assert "ARM_CLIENT_ID" in helper_text
    assert "--service-principal" in helper_text
    assert "--allow-no-subscriptions" in helper_text
    assert "COPY docker/infra-agent-azure-login" in dockerfile.read_text()
