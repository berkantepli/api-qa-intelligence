import asyncio
import json

import httpx
import pytest

from app.domain.documents import MAX_DOCUMENT_DEPTH, DocumentTooComplexError, parse_document
from app.middleware import MAX_REQUEST_BYTES

ALIAS_BOMB = "\n".join(
    ["openapi: 3.0.0", "info: {title: Bomb, version: '1'}", "x-bomb:", '  a: &a ["x","x","x","x","x","x","x","x","x","x"]']
    + [f"  n{i}: &n{i} [{','.join([f'*{prev}'] * 10)}]" for i, prev in enumerate(["a", *[f"n{j}" for j in range(1, 19)]], start=1)]
    + ["paths: {}"]
)


def test_yaml_aliases_that_expand_too_far_are_refused():
    with pytest.raises(DocumentTooComplexError, match="anchors and aliases"):
        parse_document(ALIAS_BOMB, as_json=False)


@pytest.mark.parametrize(("text", "as_json"), [
    ("[" * 5000 + "]" * 5000, True),
    ("a: " + "[" * 5000 + "]" * 5000, False),
    (json.dumps(json.loads("[" * (MAX_DOCUMENT_DEPTH + 5) + "]" * (MAX_DOCUMENT_DEPTH + 5))), True),
])
def test_deeply_nested_documents_are_refused(text, as_json):
    with pytest.raises(DocumentTooComplexError):
        parse_document(text, as_json=as_json)


def test_import_refuses_an_alias_bomb_without_hanging(client):
    response = client.post("/api/v1/specs/import", files={"file": ("bomb.yaml", ALIAS_BOMB.encode())})

    assert response.status_code == 422
    assert "anchors and aliases" in response.json()["detail"]


def test_import_explains_a_document_with_an_unexpected_shape(client):
    spec = {
        "openapi": "3.0.0", "info": {"title": "x", "version": "1"},
        "paths": {"/p": {"post": {
            "requestBody": {"content": {"application/json": {"schema": {"type": "object", "properties": []}}}},
            "responses": {"200": {"description": "ok"}},
        }}},
    }
    response = client.post("/api/v1/specs/import", files={"file": ("x.json", json.dumps(spec).encode())})

    assert response.status_code == 422
    assert "unexpected shape" in response.json()["detail"]


def test_a_deeply_nested_json_response_does_not_break_the_check(client, mock_http):
    deep = "[" * 100_000 + "]" * 100_000
    mock_http.respond_with(lambda request: httpx.Response(200, text=deep, headers={"Content-Type": "application/json"}))

    response = client.post("/api/v1/runs/execute", json={
        "base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/deep",
        "response_schemas": {"200": {"type": "array"}},
    })

    assert response.status_code == 200
    assert response.json()["schema_check"]["status"] == "skipped"


def test_an_overlong_path_is_refused_before_sending(client, mock_http):
    response = client.post("/api/v1/runs/execute", json={"base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/" + "a" * 100_000})

    assert response.status_code == 422
    assert mock_http.requests == []


def test_a_response_that_trickles_stops_at_the_overall_deadline(client, mock_http, monkeypatch):
    monkeypatch.setattr("app.domain.execution.REQUEST_TIMEOUT_SECONDS", 0.3)

    class Trickle(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(50):
                await asyncio.sleep(0.05)
                yield b"a"

    mock_http.respond_with(lambda request: httpx.Response(200, stream=Trickle()))

    result = client.post("/api/v1/runs/execute", json={"base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/slow"}).json()

    assert result["result"] == "ERROR"
    assert "did not finish responding within" in result["error"]


def test_oversized_requests_are_refused(client):
    response = client.post(
        "/api/v1/runs/execute", content=b"x" * (MAX_REQUEST_BYTES + 1), headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 413
    assert "too large" in response.json()["detail"]


def test_oversized_chunked_requests_are_refused(client):
    def chunks():
        for _ in range(MAX_REQUEST_BYTES // 1_000_000 + 2):
            yield b"x" * 1_000_000

    response = client.post("/api/v1/runs/execute", content=chunks(), headers={"Content-Type": "application/json"})

    assert response.status_code == 413


def test_cli_refuses_an_alias_bomb(tmp_path, capsys):
    from app.cli import main

    bomb = tmp_path / "bomb.yaml"
    bomb.write_text(ALIAS_BOMB)

    assert main(["diff", str(bomb), str(bomb)]) == 2
    assert "anchors and aliases" in capsys.readouterr().err
