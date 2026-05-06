import subprocess
import sys
import textwrap


def test_temporal_package_import_does_not_load_dispatcher_http_dependencies() -> None:
    script = textwrap.dedent(
        """
        import sys
        import infra_agent_platform.temporal

        assert "infra_agent_platform.temporal.dispatcher" not in sys.modules
        assert "infra_agent_platform.github_app" not in sys.modules
        assert "httpx" not in sys.modules
        """
    )

    subprocess.run([sys.executable, "-c", script], check=True)
