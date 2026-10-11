import copy
import json

import pytest

from app.cli import main
from app.domain.contract_diff import diff_contracts, diff_markdown
from app.domain.openapi import summarize_openapi

PET = {
    "type": "object",
    "required": ["id", "name"],
    "properties": {
        "id": {"type": "integer"},
        "name": {"type": "string", "maxLength": 50},
        "status": {"type": "string", "enum": ["available", "sold"]},
        "tags": {"type": "array", "items": {"type": "object", "properties": {"label": {"type": "string"}}}},
    },
}
BASE = {
    "openapi": "3.0.3",
    "info": {"title": "Pets", "version": "1.0"},
    "components": {
        "schemas": {"Pet": PET},
        "securitySchemes": {"key": {"type": "apiKey", "in": "header", "name": "X-Key"}},
    },
    "paths": {
        "/pets": {
            "get": {
                "parameters": [
                    {"name": "limit", "in": "query", "schema": {"type": "integer", "maximum": 100}},
                    {"name": "legacy", "in": "query", "schema": {"type": "string"}},
                ],
                "responses": {"200": {"content": {"application/json": {"schema": {"type": "array", "items": {"$ref": "#/components/schemas/Pet"}}}}}},
            },
            "post": {
                "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}},
                "responses": {"201": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}, "422": {}},
            },
        },
        "/pets/{id}": {
            "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}],
            "get": {"responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}, "404": {}}},
            "delete": {"responses": {"204": {}}},
        },
        "/stats": {"get": {"security": [{"key": []}], "responses": {"200": {}}}},
    },
}


def compare(change) -> dict:
    head = copy.deepcopy(BASE)
    head["info"]["version"] = "2.0"
    change(head)
    diff = diff_contracts(summarize_openapi(BASE), summarize_openapi(head))
    return diff


def changes_of(diff, key: str) -> list[tuple[str, str]]:
    endpoint = next(item for item in diff.endpoints if item.key == key)
    return [(change.severity, f"{change.location}: {change.message}") for change in endpoint.changes]


def test_identical_contracts_have_no_changes():
    diff = compare(lambda head: None)

    assert diff.endpoints == [] and diff.severity is None
    assert "No changes to endpoints" in diff_markdown(diff)


def test_removed_endpoints_break_and_new_ones_are_safe():
    def change(head):
        del head["paths"]["/stats"]
        head["paths"]["/owners"] = {"get": {"responses": {"200": {}}}}

    diff = compare(change)

    assert changes_of(diff, "GET /stats") == [("breaking", "endpoint: Endpoint removed; clients that call it will fail.")]
    assert changes_of(diff, "GET /owners") == [("safe", "endpoint: New endpoint.")]
    assert diff.endpoints[0].key == "GET /stats"


def test_a_renamed_path_parameter_is_the_same_endpoint():
    def change(head):
        item = head["paths"].pop("/pets/{id}")
        item["parameters"][0]["name"] = "petId"
        head["paths"]["/pets/{petId}"] = item

    diff = compare(change)

    assert {endpoint.status for endpoint in diff.endpoints} == {"changed"}
    renamed = next(endpoint for endpoint in diff.endpoints if endpoint.key == "GET /pets/{petId}")
    assert renamed.previous_path == "/pets/{id}"
    assert renamed.severity == "safe"


def test_parameters_and_authentication():
    def change(head):
        get = head["paths"]["/pets"]["get"]
        get["parameters"] = [
            {"name": "limit", "in": "query", "schema": {"type": "integer", "maximum": 50}},
            {"name": "owner", "in": "query", "required": True, "schema": {"type": "string"}},
            {"name": "sort", "in": "query", "schema": {"type": "string"}},
        ]
        get["security"] = [{"key": []}]
        head["paths"]["/stats"]["get"]["security"] = []

    diff = compare(change)

    assert changes_of(diff, "GET /pets") == [
        ("breaking", "authentication: Now requires authentication; clients without credentials will be rejected."),
        ("breaking", "parameter limit (query): Stricter: maximum changed from 100 to 50."),
        ("breaking", "parameter owner (query): New required parameter; clients that do not send it will be rejected."),
        ("safe", "parameter sort (query): New optional parameter."),
        ("warning", "parameter legacy (query): Parameter removed; clients that still send it may be ignored or rejected."),
    ]
    assert changes_of(diff, "GET /stats") == [
        ("warning", "authentication: No longer documents authentication; check that the endpoint is not exposed by mistake."),
    ]


def test_request_and_response_rules_point_in_opposite_directions():
    def change(head):
        pet = head["components"]["schemas"]["Pet"]
        pet["required"] = ["id", "name", "status"]
        pet["properties"]["status"]["enum"] = ["available"]
        pet["properties"]["name"]["maxLength"] = 20
        pet["properties"]["name"]["nullable"] = True
        del pet["properties"]["tags"]
        pet["properties"]["age"] = {"type": "integer"}

    diff = compare(change)
    post = dict((location, severity) for severity, location in changes_of(diff, "POST /pets"))

    # A request field: tighter rules break clients that send old values.
    assert post["request body status: Now required."] == "breaking"
    assert post["request body status: No longer allows 'sold'."] == "breaking"
    assert post["request body name: Stricter: maxLength changed from 50 to 20."] == "breaking"
    assert post["request body tags: Field removed; clients that still send it may be ignored or rejected."] == "warning"
    assert post["request body age: New optional field."] == "safe"
    # The same changes in a response promise less, except removing a field and allowing null.
    assert post["response 201 $.status: No longer allows 'sold'."] == "safe"
    assert post["response 201 $.tags: Field removed; clients that read it will fail."] == "breaking"
    assert post["response 201 $.age: New field."] == "safe"
    get_list = dict((location, severity) for severity, location in changes_of(diff, "GET /pets"))
    assert get_list["response 200 $[].name: Can now be null; check that clients handle it."] == "warning"


def test_types_and_response_codes():
    def change(head):
        head["components"]["schemas"]["Pet"]["properties"]["id"] = {"type": "string"}
        responses = head["paths"]["/pets/{id}"]["get"]["responses"]
        responses["202"] = responses.pop("200")
        del responses["404"]

    diff = compare(change)

    assert ("breaking", "response 200: Success response removed; clients that expect it will treat the new response as an error.") in changes_of(diff, "GET /pets/{id}")
    assert ("warning", "response 202: New success response; check that clients accept it.") in changes_of(diff, "GET /pets/{id}")
    assert ("safe", "response 404: Response no longer documented.") in changes_of(diff, "GET /pets/{id}")
    assert ("breaking", "response 200 $[].id: Type changed from integer to string.") in changes_of(diff, "GET /pets")


def test_changed_endpoints_list_the_checks_to_run_again():
    def change(head):
        head["components"]["schemas"]["Pet"]["properties"]["name"]["maxLength"] = 20

    diff = compare(change)
    post = next(endpoint for endpoint in diff.endpoints if endpoint.key == "POST /pets")

    assert post.retest == ["Valid request", "Check boundary values for name"]
    markdown = diff_markdown(diff)
    assert "**1 breaking**, 0 warnings" in markdown
    assert "| `POST /pets` | request body name | Stricter: maxLength changed from 50 to 20. |" in markdown
    assert "- `POST /pets`: Valid request, Check boundary values for name" in markdown


def test_diff_route_compares_two_overviews(client):
    head = copy.deepcopy(BASE)
    del head["paths"]["/stats"]

    response = client.post("/api/v1/specs/diff", json={
        "base": summarize_openapi(BASE).model_dump(), "head": summarize_openapi(head).model_dump(),
    })

    assert response.status_code == 200
    body = response.json()
    assert body["totals"] == {"endpoints": 1, "breaking": 1, "warning": 0, "safe": 0, "retest": 0}
    assert body["endpoints"][0]["severity"] == "breaking"
    assert body["markdown"].startswith("## Contract changes: Pets 1.0 → 1.0")


@pytest.fixture
def contracts(tmp_path):
    def write(change=None):
        head = copy.deepcopy(BASE)
        if change:
            change(head)
        (tmp_path / "base.json").write_text(json.dumps(BASE))
        (tmp_path / "head.json").write_text(json.dumps(head))
        return str(tmp_path / "base.json"), str(tmp_path / "head.json")

    return write


def test_cli_diff_exits_1_on_breaking_changes_and_writes_reports(contracts, tmp_path, capsys):
    base, head = contracts(lambda doc: doc["paths"].pop("/stats"))

    code = main(["diff", base, head, "--markdown", str(tmp_path / "diff.md"), "--json", str(tmp_path / "diff.json")])

    assert code == 1
    assert "BREAKING GET /stats" in capsys.readouterr().err
    assert "### Breaking" in (tmp_path / "diff.md").read_text()
    assert json.loads((tmp_path / "diff.json").read_text())["totals"]["breaking"] == 1
    assert main(["diff", base, head, "--fail-on", "never"]) == 0


def test_cli_diff_fail_on_warning_and_markdown_to_stdout(contracts, capsys):
    base, head = contracts(lambda doc: doc["paths"]["/pets"]["get"]["parameters"].pop())

    assert main(["diff", base, head]) == 0
    assert main(["diff", base, head, "--fail-on", "warning", "--markdown", "-"]) == 1
    assert "### Warning" in capsys.readouterr().out
    assert main(["diff", base, "missing.json"]) == 2
