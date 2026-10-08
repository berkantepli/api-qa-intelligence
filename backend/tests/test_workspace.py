import sqlite3

import pytest

from app.domain.store import SCHEMA_VERSION, WorkspaceStore

API = {
    "id": "Pets::https://pets.test/openapi.json",
    "title": "Pets",
    "overview": {"operations": [{"method": "GET", "path": "/pets", "parameters": [{"name": "X-Key", "location": "header", "credential": True}]}]},
}
RUN = {"id": 1700000000001, "apiId": API["id"], "endpoint": "GET /pets", "createdAt": "2026-10-08T10:00:00Z", "results": [{"result": "PASS"}]}


def test_saved_apis_runs_and_inputs_round_trip(client):
    assert client.get("/api/v1/workspace").json() == {"savedApis": [], "runHistory": [], "requestInputs": {}}

    assert client.put(f"/api/v1/workspace/apis/{API['id']}", params={"position": 0}, json=API).status_code == 204
    assert client.put(f"/api/v1/workspace/runs/{RUN['id']}", json=RUN).status_code == 204
    inputs = {"GET /pets": {"parameter:query:limit": "5", "parameter:header:X-Key": "secret"}}
    assert client.put(f"/api/v1/workspace/inputs/{API['id']}", json=inputs).status_code == 204

    workspace = client.get("/api/v1/workspace").json()
    assert workspace["savedApis"] == [API]
    assert workspace["runHistory"] == [RUN]
    # Credentials never reach the database, even when a client sends them.
    assert workspace["requestInputs"] == {API["id"]: {"GET /pets": {"parameter:query:limit": "5"}}}


def test_order_updates_and_deletes(client):
    second = {**API, "id": "Shop::https://shop.test/openapi.json", "title": "Shop"}
    client.put(f"/api/v1/workspace/apis/{API['id']}", params={"position": 1}, json=API)
    client.put(f"/api/v1/workspace/apis/{second['id']}", params={"position": 0}, json=second)
    client.put(f"/api/v1/workspace/apis/{API['id']}", params={"position": 1}, json={**API, "title": "Pets v2"})
    client.put(f"/api/v1/workspace/runs/{RUN['id']}", json=RUN)

    assert [api["title"] for api in client.get("/api/v1/workspace").json()["savedApis"]] == ["Shop", "Pets v2"]

    client.delete(f"/api/v1/workspace/apis/{second['id']}")
    client.delete(f"/api/v1/workspace/runs/{RUN['id']}")
    workspace = client.get("/api/v1/workspace").json()
    assert [api["title"] for api in workspace["savedApis"]] == ["Pets v2"]
    assert workspace["runHistory"] == []

    assert client.delete("/api/v1/workspace").status_code == 204
    assert client.get("/api/v1/workspace").json()["savedApis"] == []


@pytest.mark.parametrize(
    ("path", "body"),
    [
        ("/api/v1/workspace/apis/other", API),
        (f"/api/v1/workspace/apis/{API['id']}", {"id": API["id"]}),
        ("/api/v1/workspace/runs/1", {**RUN, "id": 2}),
    ],
)
def test_mismatched_or_incomplete_records_are_rejected(client, path, body):
    assert client.put(path, json=body).status_code == 422


def test_database_records_its_schema_and_refuses_newer_ones(tmp_path):
    path = tmp_path / "workspace.db"
    WorkspaceStore(path).save_run(RUN)
    assert WorkspaceStore(path).load()["runHistory"] == [RUN]

    with sqlite3.connect(path) as db:
        db.execute("UPDATE meta SET value = ? WHERE key = 'schema_version'", (str(SCHEMA_VERSION + 1),))
    with pytest.raises(RuntimeError, match="newer version"):
        WorkspaceStore(path)
