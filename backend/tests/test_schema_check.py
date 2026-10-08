import httpx
import pytest

from app.domain.openapi import summarize_openapi
from app.domain.schema_check import check_response, schema_for_status, validate

PET = {
    "type": "object",
    "required": ["id", "name"],
    "properties": {
        "id": {"type": "integer", "minimum": 1},
        "name": {"type": "string", "minLength": 1},
        "status": {"type": "string", "enum": ["available", "sold"]},
        "tag": {"type": "string", "nullable": True},
        "photos": {"type": "array", "items": {"type": "string"}},
    },
}
DOCUMENT = {
    "openapi": "3.0.3",
    "info": {"title": "Pets", "version": "1"},
    "components": {
        "schemas": {"Pet": PET, "Node": {"type": "object", "properties": {"child": {"$ref": "#/components/schemas/Node"}}}},
        "responses": {"NotFound": {"content": {"application/json": {"schema": {"type": "object", "required": ["message"]}}}}},
    },
    "paths": {
        "/pets/{id}": {
            "get": {
                "responses": {
                    "200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}},
                    "404": {"$ref": "#/components/responses/NotFound"},
                    "5XX": {"content": {"application/problem+json": {"schema": {"type": "object"}}}},
                    "204": {"description": "No content"},
                }
            }
        },
        "/nodes": {"get": {"responses": {"200": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Node"}}}}}}},
    },
}


def test_contract_carries_resolved_response_schemas():
    operations = {item.path: item for item in summarize_openapi(DOCUMENT).operations}
    schemas = operations["/pets/{id}"].response_schemas

    assert set(schemas) == {"200", "404", "5XX"}
    assert schemas["200"]["required"] == ["id", "name"]
    assert schema_for_status(schemas, 503) == {"type": "object"}
    assert schema_for_status(schemas, 204) is None
    # A self-referencing schema stops at the cycle instead of recursing forever.
    assert operations["/nodes"].response_schemas["200"]["properties"]["child"] == {}


def test_valid_body_has_no_differences():
    assert validate({"id": 1, "name": "Rex", "status": "sold", "tag": None, "photos": ["a"], "extra": True}, PET) == []


@pytest.mark.parametrize(
    ("body", "difference"),
    [
        ({"name": "Rex"}, "$.id: required property is missing"),
        ({"id": "1", "name": "Rex"}, "$.id: expected integer, received string"),
        ({"id": 0, "name": "Rex"}, "$.id: 0 is below the minimum 1"),
        ({"id": 1, "name": "Rex", "status": "lost"}, "$.status: 'lost' is not one of 'available', 'sold'"),
        ({"id": 1, "name": "Rex", "photos": ["a", 2]}, "$.photos[1]: expected string, received number"),
        ([], "$: expected object, received array"),
    ],
)
def test_differences_name_the_path(body, difference):
    assert difference in validate(body, PET)


def test_type_lists_combinators_and_closed_objects():
    assert validate(None, {"type": ["string", "null"]}) == []
    assert validate(3, {"anyOf": [{"type": "string"}, {"type": "integer"}]}) == []
    assert validate(True, {"oneOf": [{"type": "string"}, {"type": "integer"}]}) == ["$: does not match any of the documented alternatives"]
    assert validate({"a": 1}, {"allOf": [{"type": "object", "required": ["b"]}]}) == ["$.b: required property is missing"]
    assert validate({"a": 1, "b": 2}, {"type": "object", "properties": {"a": {}}, "additionalProperties": False}) == ["$.b: property is not documented"]


def test_check_response_outcomes():
    schemas = {"200": PET}

    assert check_response({}, 200, "application/json", b"{}", False).status == "not_documented"
    assert check_response(schemas, 201, "application/json", b"{}", False).status == "not_documented"
    assert check_response(schemas, 200, "application/json", b'{"id": 1}', True).status == "skipped"
    assert check_response(schemas, 200, "application/json", b'{"id": 1, "name": "Rex"}', False).status == "passed"
    assert check_response(schemas, 200, "text/html", b"<html>", False).errors == ["$: expected a JSON response, received text/html"]
    assert check_response(schemas, 200, "application/json", b"", False).status == "failed"
    failed = check_response(schemas, 200, "application/json", b'{"id": "x"}', False)
    assert failed.status == "failed"
    assert failed.detail == "2 differences from the documented schema."


def execute(client, **overrides):
    payload = {"base_url": "http://127.0.0.1:8000", "method": "GET", "path": "/pets/1", "response_schemas": {"200": PET}, **overrides}
    return client.post("/api/v1/runs/execute", json=payload).json()


def test_matching_status_with_a_wrong_body_fails(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"id": "1"}))

    result = execute(client)

    assert result["result"] == "FAIL"
    assert result["schema_check"]["status"] == "failed"
    assert "$.name: required property is missing" in result["schema_check"]["errors"]


def test_matching_status_and_body_passes(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"id": 1, "name": "Rex"}))

    result = execute(client)

    assert result["result"] == "PASS"
    assert result["schema_check"]["status"] == "passed"


def test_body_is_not_checked_when_the_status_already_fails_or_no_schema_is_sent(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(500, json={"oops": True}))
    assert execute(client)["schema_check"] is None

    mock_http.respond_with(lambda request: httpx.Response(200, json={"anything": True}))
    result = execute(client, response_schemas={})
    assert (result["result"], result["schema_check"]) == ("PASS", None)
