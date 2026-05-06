import os
import subprocess
from pathlib import Path


def test_azure_login_helper_logs_in_from_arm_environment(tmp_path: Path) -> None:
    calls = tmp_path / "calls.log"
    fake_az = tmp_path / "real-az"
    fake_az.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$CALLS_LOG\"\n"
        "if [[ \"$*\" == 'account show --only-show-errors' ]]; then exit 1; fi\n"
        "exit 0\n"
    )
    fake_az.chmod(0o755)

    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "CALLS_LOG": str(calls),
        "INFRA_AGENT_REAL_AZ": str(fake_az),
        "ARM_CLIENT_ID": "client-id",
        "ARM_CLIENT_SECRET": "client-secret",
        "ARM_TENANT_ID": "tenant-id",
        "ARM_SUBSCRIPTION_ID": "sub-id",
    }

    path = f"{tmp_path}:{env.get('PATH', '')}"
    fake_link = tmp_path / "az"
    fake_link.symlink_to(fake_az)
    env["PATH"] = path

    subprocess.run(
        [str(Path("docker/infra-agent-azure-login").resolve())],
        check=True,
        env=env,
    )

    assert calls.read_text().splitlines() == [
        "account show --only-show-errors",
        (
            "login --service-principal --username client-id --password client-secret "
            "--tenant tenant-id --allow-no-subscriptions --only-show-errors --output none"
        ),
        "account set --subscription sub-id --only-show-errors",
    ]


def test_azure_login_helper_fails_without_credentials(tmp_path: Path) -> None:
    calls = tmp_path / "calls.log"
    fake_az = tmp_path / "real-az"
    fake_az.write_text(
        "#!/usr/bin/env bash\n"
        "printf '%s\\n' \"$*\" >> \"$CALLS_LOG\"\n"
        "exit 0\n"
    )
    fake_az.chmod(0o755)

    env = {
        **os.environ,
        "HOME": str(tmp_path),
        "CALLS_LOG": str(calls),
        "INFRA_AGENT_REAL_AZ": str(fake_az),
    }
    for name in (
        "ARM_CLIENT_ID",
        "ARM_CLIENT_SECRET",
        "ARM_TENANT_ID",
        "ARM_SUBSCRIPTION_ID",
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_TENANT_ID",
        "AZURE_SUBSCRIPTION_ID",
    ):
        env.pop(name, None)

    fake_link = tmp_path / "az"
    fake_link.symlink_to(fake_az)
    env["PATH"] = f"{tmp_path}:{env.get('PATH', '')}"

    completed = subprocess.run(
        [str(Path("docker/infra-agent-azure-login").resolve())],
        check=False,
        env=env,
        capture_output=True,
        text=True,
    )

    assert completed.returncode == 2
    assert "Azure service-principal env vars are not set" in completed.stderr
    assert not calls.exists()
