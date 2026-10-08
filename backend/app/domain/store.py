"""SQLite storage for the workspace: saved APIs, Run history, and request details.

Each record is stored as the JSON document the web app works with, so the app's data shapes
stay in one place (the frontend) while the backend keeps them durable. The schema is versioned
in the ``meta`` table; ``MIGRATIONS`` upgrades older databases in order.
"""

import json
import os
import sqlite3
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from pathlib import Path
from typing import Any

SCHEMA_VERSION = 1
MIGRATIONS: dict[int, str] = {
    1: """
        CREATE TABLE apis (id TEXT PRIMARY KEY, position INTEGER NOT NULL, data TEXT NOT NULL, updated_at TEXT NOT NULL);
        CREATE TABLE runs (id TEXT PRIMARY KEY, api_id TEXT, created_at TEXT NOT NULL, data TEXT NOT NULL);
        CREATE INDEX runs_created_at ON runs (created_at DESC);
        CREATE TABLE request_inputs (api_id TEXT PRIMARY KEY, data TEXT NOT NULL);
    """,
}


def default_database_path() -> Path:
    """API_QA_DATA_DIR, else data/ in a source checkout, else ~/.api-qa-intelligence for an installed package."""
    data_dir = os.getenv("API_QA_DATA_DIR")
    if data_dir:
        return Path(data_dir) / "workspace.db"
    repository = Path(__file__).resolve().parents[3]
    base = repository / "data" if (repository / "VERSION").is_file() else Path.home() / ".api-qa-intelligence"
    return base / "workspace.db"


class WorkspaceStore:
    def __init__(self, path: Path | str):
        self.path = Path(path)
        self._lock = threading.Lock()
        if str(path) != ":memory:":
            self.path.parent.mkdir(parents=True, exist_ok=True)
        self._connection = sqlite3.connect(str(path), check_same_thread=False)
        self._connection.execute("PRAGMA journal_mode=WAL")
        self._migrate()

    @contextmanager
    def _transaction(self) -> Iterator[sqlite3.Connection]:
        with self._lock, self._connection:
            yield self._connection

    def _migrate(self) -> None:
        with self._transaction() as db:
            db.execute("CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
            row = db.execute("SELECT value FROM meta WHERE key = 'schema_version'").fetchone()
            version = int(row[0]) if row else 0
            if version > SCHEMA_VERSION:
                raise RuntimeError(f"The workspace database is from a newer version (schema {version}).")
            for target in range(version + 1, SCHEMA_VERSION + 1):
                db.executescript(MIGRATIONS[target])
            db.execute("INSERT OR REPLACE INTO meta (key, value) VALUES ('schema_version', ?)", (str(SCHEMA_VERSION),))

    def load(self) -> dict[str, Any]:
        with self._transaction() as db:
            apis = [json.loads(row[0]) for row in db.execute("SELECT data FROM apis ORDER BY position, updated_at DESC")]
            runs = [json.loads(row[0]) for row in db.execute("SELECT data FROM runs ORDER BY created_at DESC")]
            inputs = {row[0]: json.loads(row[1]) for row in db.execute("SELECT api_id, data FROM request_inputs")}
        return {"savedApis": apis, "runHistory": runs, "requestInputs": inputs}

    def is_empty(self) -> bool:
        with self._transaction() as db:
            return not any(db.execute(f"SELECT 1 FROM {table} LIMIT 1").fetchone() for table in ("apis", "runs"))

    def save_api(self, api: dict[str, Any], position: int) -> None:
        with self._transaction() as db:
            db.execute(
                "INSERT OR REPLACE INTO apis (id, position, data, updated_at) VALUES (?, ?, ?, datetime('now'))",
                (api["id"], position, json.dumps(api)),
            )

    def delete_api(self, api_id: str) -> None:
        with self._transaction() as db:
            db.execute("DELETE FROM apis WHERE id = ?", (api_id,))
            db.execute("DELETE FROM request_inputs WHERE api_id = ?", (api_id,))

    def get_api(self, api_id: str) -> dict[str, Any] | None:
        with self._transaction() as db:
            row = db.execute("SELECT data FROM apis WHERE id = ?", (api_id,)).fetchone()
        return json.loads(row[0]) if row else None

    def save_run(self, run: dict[str, Any]) -> None:
        with self._transaction() as db:
            db.execute(
                "INSERT OR REPLACE INTO runs (id, api_id, created_at, data) VALUES (?, ?, ?, ?)",
                (str(run["id"]), run.get("apiId"), str(run.get("createdAt", "")), json.dumps(run)),
            )

    def delete_run(self, run_id: str) -> None:
        with self._transaction() as db:
            db.execute("DELETE FROM runs WHERE id = ?", (run_id,))

    def save_inputs(self, api_id: str, inputs: dict[str, Any]) -> None:
        with self._transaction() as db:
            if inputs:
                db.execute("INSERT OR REPLACE INTO request_inputs (api_id, data) VALUES (?, ?)", (api_id, json.dumps(inputs)))
            else:
                db.execute("DELETE FROM request_inputs WHERE api_id = ?", (api_id,))

    def clear(self) -> None:
        with self._transaction() as db:
            for table in ("apis", "runs", "request_inputs"):
                db.execute(f"DELETE FROM {table}")
