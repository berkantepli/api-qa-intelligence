import json

import httpx
import pytest

from app.api.specs import MAX_SPEC_SIZE_BYTES

SPEC_URL = "http://127.0.0.1:8000/openapi.json"


def test_imports_json_file(client, sample_spec):
    response = client.post(
        "/api/v1/specs/import",
        files={"file": ("spec.json", json.dumps(sample_spec), "application/json")},
    )

    assert response.status_code == 200
    assert response.json()["title"] == "Pets"
    assert response.json()["operation_count"] == 6


def test_imports_yaml_file(client):
    spec = "openapi: 3.1.0\ninfo:\n  title: Yaml API\n  version: '2'\npaths:\n  /ping:\n    get:\n      responses:\n        '200': {}\n"

    response = client.post("/api/v1/specs/import", files={"file": ("spec.yaml", spec, "text/yaml")})

    assert response.status_code == 200
    assert response.json()["operations"][0]["path"] == "/ping"


def test_rejects_invalid_and_oversized_files(client):
    invalid = client.post("/api/v1/specs/import", files={"file": ("spec.json", "{not json", "application/json")})
    too_large = client.post(
        "/api/v1/specs/import", files={"file": ("spec.json", b" " * (MAX_SPEC_SIZE_BYTES + 1), "application/json")}
    )
    not_openapi = client.post("/api/v1/specs/import", files={"file": ("spec.json", "[]", "application/json")})

    assert invalid.status_code == 400
    assert too_large.status_code == 413
    assert not_openapi.status_code == 422


def test_imports_from_url_with_a_single_get(client, mock_http, sample_spec):
    mock_http.respond_with(lambda request: httpx.Response(200, json=sample_spec))

    response = client.post("/api/v1/specs/import-url", json={"url": SPEC_URL})

    assert response.status_code == 200
    assert response.json()["title"] == "Pets"
    assert [(request.method, str(request.url)) for request in mock_http.requests] == [("GET", SPEC_URL)]


def test_url_import_does_not_follow_redirects(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(302, headers={"Location": "http://10.0.0.1/spec"}))

    response = client.post("/api/v1/specs/import-url", json={"url": SPEC_URL})

    assert response.status_code == 502
    assert response.json()["detail"] == "The OpenAPI URL redirects to http://10.0.0.1/spec. Use that address instead."
    assert len(mock_http.requests) == 1


def test_url_import_rejects_credentials_and_private_hosts(client, mock_http):
    with_credentials = client.post("/api/v1/specs/import-url", json={"url": "http://u:p@127.0.0.1:8000/openapi.json"})
    private_host = client.post("/api/v1/specs/import-url", json={"url": "http://10.0.0.1/openapi.json"})

    assert with_credentials.status_code == 422
    assert private_host.status_code == 422
    assert private_host.json()["detail"].startswith("The OpenAPI URL must use a public host or localhost.")
    assert "API_QA_ALLOW_PRIVATE_NETWORK=1" in private_host.json()["detail"]
    assert mock_http.requests == []


@pytest.mark.parametrize(
    ("respond", "message"),
    [
        (lambda request: httpx.Response(404), "returned 404 Not Found"),
        (lambda request: httpx.Response(401), "needs authentication"),
        (lambda request: httpx.Response(500), "returned HTTP 500"),
        (lambda request: httpx.Response(200, text="<!doctype html><html></html>"), "HTML or XML page, not an OpenAPI document"),
        (lambda request: httpx.Response(200, text="just some text"), "This is not an OpenAPI document"),
    ],
)
def test_url_import_explains_what_came_back(client, mock_http, respond, message):
    mock_http.respond_with(respond)

    response = client.post("/api/v1/specs/import-url", json={"url": SPEC_URL.removesuffix(".json") + ".yaml"})

    assert message in response.json()["detail"]


def test_url_import_explains_a_closed_port(client, mock_http):
    def refuse(request):
        raise httpx.ConnectError("refused", request=request)

    mock_http.respond_with(refuse)

    response = client.post("/api/v1/specs/import-url", json={"url": SPEC_URL})

    assert response.json()["detail"].startswith("Could not connect to the OpenAPI URL: the connection was refused")
