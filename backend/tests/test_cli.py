import json
from xml.etree import ElementTree

import httpx
import pytest

from app.cli import main

CONTRACT = {
    "openapi": "3.0.3",
    "info": {"title": "Pets", "version": "1.0"},
    "servers": [{"url": "http://127.0.0.1:8000/v1"}],
    "components": {"securitySchemes": {"key": {"type": "apiKey", "in": "header", "name": "X-Key"}}},
    "paths": {
        "/pets": {
            "get": {
                "security": [{"key": []}],
                "responses": {
                    "200": {"content": {"application/json": {"schema": {"type": "array", "items": {"type": "object", "required": ["name"]}}}}},
                    "401": {},
                },
            },
            "post": {
                "requestBody": {"required": True, "content": {"application/json": {"schema": {"type": "object", "properties": {"name": {"type": "string"}}}}}},
                "responses": {"201": {}},
            },
        },
        "/pets/{id}": {"get": {"parameters": [{"name": "id", "in": "path", "required": True}], "responses": {"200": {}}}},
    },
}


@pytest.fixture
def spec(tmp_path):
    path = tmp_path / "openapi.json"
    path.write_text(json.dumps(CONTRACT))
    return str(path)


def pets_api(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/v1/pets" and request.method == "GET":
        if request.headers.get("X-Key") != "secret":
            return httpx.Response(401)
        return httpx.Response(200, json=[{"name": "Rex"}])
    if request.method == "POST":
        return httpx.Response(201, json={})
    # /v1/pets/ (the path parameter left out) is not a pet.
    return httpx.Response(200 if request.url.path.rstrip("/") != "/v1/pets" else 404, json={})


def test_all_checks_pass_with_exit_code_0(spec, mock_http, tmp_path):
    mock_http.respond_with(pets_api)

    code = main(["run", "--spec", spec, "--header", "X-Key: secret", "--param", "id=7", "--json", str(tmp_path / "r.json")])

    report = json.loads((tmp_path / "r.json").read_text())
    assert code == 0
    assert report["totals"]["passed"] == report["totals"]["checks"] == 4
    skipped = {f"{e['method']} {e['path']}": e["skipped_reason"] for e in report["endpoints"] if e["skipped_reason"]}
    assert skipped == {"POST /pets": "Changes data; pass --include-writes to run it."}
    assert "http://127.0.0.1:8000/v1/pets/7" in [str(request.url) for request in mock_http.requests]
    # The credential reaches the API but is redacted in the report, and the unauthenticated check leaves it out.
    assert "secret" not in (tmp_path / "r.json").read_text()
    unauthenticated = [r for r in mock_http.requests if r.url.path == "/v1/pets" and "X-Key" not in r.headers]
    assert len(unauthenticated) == 1


def test_failures_exit_1_and_reach_the_junit_report(spec, mock_http, tmp_path):
    mock_http.respond_with(lambda request: httpx.Response(200, json=[{"nickname": "Rex"}]))

    code = main(["run", "--spec", spec, "--param", "id=7", "--junit", str(tmp_path / "r.xml")])

    suites = ElementTree.parse(tmp_path / "r.xml").getroot()
    assert code == 1
    assert (suites.get("tests"), suites.get("failures"), suites.get("skipped")) == ("5", "3", "1")
    pets = suites.find("testsuite[@name='GET /pets']")
    unauthenticated = pets.find("testcase[@name='Call without authentication']/failure")
    # The contract documents 401, so that is the expected code.
    assert unauthenticated.get("message") == "Expected HTTP 401, received HTTP 200."
    schema = pets.find("testcase[@name='Valid request']/failure")
    assert schema.get("message").startswith("HTTP 200 as expected, but the body does not match")
    assert "$[0].name: required property is missing" in schema.text


def test_missing_inputs_skip_the_endpoint_unless_asked_to_fail(spec, mock_http, tmp_path):
    mock_http.respond_with(pets_api)
    args = ["run", "--spec", spec, "--header", "X-Key: secret", "--endpoint", "GET /pets*", "--json", str(tmp_path / "r.json")]

    assert main(args) == 0
    report = json.loads((tmp_path / "r.json").read_text())
    assert report["endpoints"][-1]["skipped_reason"] == "Missing id (path)."
    assert main([*args, "--fail-on-skipped"]) == 1


def test_include_writes_and_smoke(spec, mock_http):
    mock_http.respond_with(pets_api)

    assert main(["run", "--spec", spec, "--header", "X-Key: secret", "--param", "id=1", "--include-writes", "--smoke"]) == 0
    assert [request.method for request in mock_http.requests] == ["GET", "POST", "GET"]


@pytest.mark.parametrize(
    ("args", "message"),
    [
        (["--spec", "missing.json"], "could not be read"),
        (["--spec", "{spec}", "--header", "bad"], "must look like 'Name: value'"),
        (["--spec", "{spec}", "--target", "http://10.0.0.5"], "public host or localhost"),
    ],
)
def test_usage_problems_exit_2(spec, mock_http, capsys, args, message):
    assert main(["run", *[arg.format(spec=spec) for arg in args]]) == 2
    assert message in capsys.readouterr().err


def test_private_targets_need_an_explicit_flag(spec, mock_http):
    mock_http.respond_with(pets_api)

    assert main(["run", "--spec", spec, "--target", "http://10.0.0.5/v1", "--allow-private-network", "--smoke", "--endpoint", "GET /pets"]) == 1
    assert str(mock_http.requests[0].url) == "http://10.0.0.5/v1/pets"
