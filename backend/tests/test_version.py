import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
VERSION = (ROOT / "VERSION").read_text(encoding="utf-8").strip()


def test_version_is_semver_and_matches_package_manifests():
    assert re.fullmatch(r"\d+\.\d+\.\d+", VERSION)
    pyproject = (ROOT / "pyproject.toml").read_text(encoding="utf-8")
    assert re.search(r'^version = "([^"]+)"', pyproject, re.MULTILINE).group(1) == VERSION
    assert json.loads((ROOT / "frontend" / "package.json").read_text(encoding="utf-8"))["version"] == VERSION


def test_backend_reports_the_version(client):
    assert client.get("/health").json() == {"status": "ok", "version": VERSION}
    assert client.get("/openapi.json").json()["info"]["version"] == VERSION


def test_only_local_host_names_are_answered(client):
    """A page re-pointed to 127.0.0.1 by DNS rebinding sends its own Host header and is refused."""
    assert client.get("/health", headers={"host": "evil.example"}).status_code == 400
    assert client.get("/health", headers={"host": "127.0.0.1:8001"}).status_code == 200
    assert client.get("/health", headers={"host": "localhost"}).status_code == 200
