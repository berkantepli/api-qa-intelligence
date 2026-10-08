from importlib.metadata import PackageNotFoundError, version
from pathlib import Path

# The repository's VERSION file is the single source of the app version. An installed package
# (for example in a CI job) has no VERSION file and reads the version recorded at install time.
_VERSION_FILE = Path(__file__).resolve().parents[2] / "VERSION"


def _read_version() -> str:
    if _VERSION_FILE.is_file():
        return _VERSION_FILE.read_text(encoding="utf-8").strip()
    try:
        return version("api-qa-intelligence")
    except PackageNotFoundError:
        return "0.0.0"


APP_VERSION = _read_version()
