import json

import pytest

from app.domain.request_import import RequestFileError, parse_request_file

SCHEMA = "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"


def collection(items, variables=None):
    return {"info": {"name": "Pets", "schema": SCHEMA}, "variable": variables or [], "item": items}


def read(document):
    return parse_request_file(json.dumps(document).encode())


def test_postman_requests_resolve_variables_and_folders():
    result = read(collection(
        [{"name": "Folder", "item": [
            {"name": "Get pet", "request": {"method": "GET", "url": {
                "raw": "{{baseUrl}}/pets/{{petId}}?verbose=true", "host": ["{{baseUrl}}"], "path": ["pets", "{{petId}}"],
                "query": [{"key": "verbose", "value": "true"}, {"key": "skip", "value": "1", "disabled": True}],
            }}},
            {"name": "Order", "request": {"method": "get", "url": {"raw": "{{baseUrl}}/orders/:orderId", "path": ["orders", ":orderId"], "variable": [{"key": "orderId", "value": "5"}]}}},
        ]},
         {"name": "Plain", "request": "https://api.example.com/v1/pets?status=sold"}],
        [{"key": "baseUrl", "value": "https://api.example.com/v1"}, {"key": "petId", "value": "10"}],
    ))

    assert (result.source, result.name) == ("postman", "Pets")
    assert [(r.method, r.path, r.query) for r in result.requests] == [
        ("GET", "/pets/10", {"verbose": "true"}),
        ("GET", "/orders/5", {}),
        ("GET", "/v1/pets", {"status": "sold"}),
    ]


def test_unresolved_variables_become_placeholders_and_bodies_are_read():
    result = read(collection([
        {"name": "Get user", "request": {"method": "GET", "url": "{{baseUrl}}/users/{{username}}"}},
        {"name": "Create", "request": {"method": "POST", "url": "{{baseUrl}}/pets", "body": {"mode": "raw", "raw": '{"name": "Rex", "age": {{age}}}'}}},
        {"name": "Form", "request": {"method": "POST", "url": "{{baseUrl}}/login", "body": {"mode": "urlencoded", "urlencoded": [
            {"key": "user", "value": "qa"}, {"key": "note", "value": "{{note}}"}, {"key": "photo", "type": "file", "src": "a.png"},
        ]}}},
    ], [{"key": "age", "value": "3"}]))

    assert result.requests[0].path == "/users/{username}"
    assert result.requests[1].json_body == {"name": "Rex", "age": 3}
    # A form value that is still a variable carries no real value.
    assert result.requests[2].form_fields == {"user": "qa"}


def test_credentials_are_never_read_and_secret_values_are_left_out():
    result = read(collection(
        [{"name": "Create", "request": {
            "method": "POST",
            "header": [{"key": "Authorization", "value": "Bearer abcdefghijklmnop"}],
            "auth": {"type": "bearer", "bearer": [{"key": "token", "value": "t0ken"}]},
            "url": {"raw": "{{baseUrl}}/pets?api_key=k&page=2", "path": ["pets"], "query": [{"key": "api_key", "value": "k"}, {"key": "page", "value": "2"}]},
            "body": {"mode": "raw", "raw": json.dumps({"name": "Rex", "password": "x", "owner": {"session": "s"}, "note": "Bearer abcdefghijklmnop"})},
        }}],
        [{"key": "apiToken", "value": "s3cr3t-value"}],
    ))

    request = result.requests[0]
    assert request.query == {"page": "2"}
    assert request.json_body == {"name": "Rex", "owner": {}}
    assert result.left_out_secrets == 5
    dumped = result.model_dump_json()
    assert "abcdefghijklmnop" not in dumped and "s3cr3t-value" not in dumped and "t0ken" not in dumped


def test_har_keeps_api_calls_only():
    result = read({"log": {"creator": {"name": "Chrome"}, "entries": [
        {"_resourceType": "fetch", "request": {"method": "POST", "url": "https://api.example.com/v1/pets?x=1", "queryString": [{"name": "x", "value": "1"}, {"name": "token", "value": "t"}],
            "headers": [{"name": "Cookie", "value": "sid=abc"}], "postData": {"mimeType": "application/json", "text": '{"name": "Rex"}'}}},
        {"_resourceType": "xhr", "request": {"method": "POST", "url": "https://api.example.com/v1/login", "postData": {"mimeType": "application/x-www-form-urlencoded", "params": [{"name": "user", "value": "qa"}, {"name": "password", "value": "p"}]}}},
        {"_resourceType": "script", "request": {"method": "GET", "url": "https://api.example.com/app.js"}},
        {"request": {"method": "GET", "url": "https://api.example.com/logo.svg"}},
        {"_resourceType": "fetch", "request": {"method": "POST", "url": "https://api.example.com/v1/pets?x=1", "queryString": [{"name": "x", "value": "1"}], "postData": {"mimeType": "application/json", "text": '{"name": "Rex"}'}}},
    ]}})

    assert (result.source, result.name, result.skipped, result.left_out_secrets) == ("har", "HAR from Chrome", 2, 2)
    # The repeated request is listed once.
    assert [(r.method, r.path, r.query, r.json_body, r.form_fields) for r in result.requests] == [
        ("POST", "/v1/pets", {"x": "1"}, {"name": "Rex"}, {}),
        ("POST", "/v1/login", {}, None, {"user": "qa"}),
    ]


@pytest.mark.parametrize(("contents", "message"), [
    (b"\xff\xfe", "not JSON"),
    (b"[]", "Choose a Postman collection"),
    (json.dumps({"run": {"executions": []}}).encode(), "This is a Newman report"),
    (json.dumps({"openapi": "3.0.0"}).encode(), "neither a Postman collection"),
])
def test_other_files_are_refused(contents, message):
    with pytest.raises(RequestFileError, match=message):
        parse_request_file(contents)


def test_parse_route(client):
    body = json.dumps(collection([{"name": "List", "request": {"method": "GET", "url": "https://x/pets"}}]))

    response = client.post("/api/v1/requests/parse", files={"file": ("pets.postman_collection.json", body, "application/json")})
    refused = client.post("/api/v1/requests/parse", files={"file": ("x.json", "{}", "application/json")})

    assert response.status_code == 200 and response.json()["requests"][0]["path"] == "/pets"
    assert refused.status_code == 422


def _collection(items, variables=None):
    return {
        "info": {"name": "C", "schema": "https://schema.getpostman.com/json/collection/v2.1.0/collection.json"},
        "item": items, "variable": variables or [],
    }


def test_a_long_variable_cannot_blow_up_the_result(client):
    items = [{"name": f"r{i}", "request": {"method": "GET", "url": f"{{{{base}}}}/p{i}/{{{{v}}}}"}} for i in range(500)]
    body = json.dumps(_collection(items, [{"key": "v", "value": "A" * 1_000_000}])).encode()

    response = client.post("/api/v1/requests/parse", files={"file": ("c.json", body)})

    assert response.status_code == 200
    assert len(response.content) < 200_000
    assert response.json()["requests"] == []


def test_a_variable_repeated_in_a_body_is_left_out(client):
    raw = "[" + ",".join(['"{{v}}"'] * 1000) + "]"
    items = [{"name": "r", "request": {"method": "POST", "url": "{{base}}/x", "body": {"mode": "raw", "raw": raw}}}]
    body = json.dumps(_collection(items, [{"key": "v", "value": "A" * 10_000}])).encode()

    result = client.post("/api/v1/requests/parse", files={"file": ("c.json", body)}).json()

    assert result["requests"][0]["json_body"] is None


def test_deeply_nested_bodies_do_not_break_the_import(client):
    deep = "[" * 50_000 + "]" * 50_000
    postman = _collection([{"name": "deep", "request": {"method": "POST", "url": "{{base}}/x", "body": {"mode": "raw", "raw": deep}}}])
    har = {"log": {"entries": [{"_resourceType": "fetch", "request": {
        "method": "POST", "url": "https://api.example.com/x", "postData": {"mimeType": "application/json", "text": deep},
    }}]}}

    for document in (postman, har):
        response = client.post("/api/v1/requests/parse", files={"file": ("c.json", json.dumps(document).encode())})
        assert response.status_code == 200
        assert response.json()["requests"][0]["json_body"] is None


def test_secrets_in_a_path_are_left_out(client):
    har = {"log": {"entries": [{"_resourceType": "xhr", "request": {
        "method": "GET", "url": "https://api.example.com/v1/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcDEFghi/items",
    }}]}}

    result = client.post("/api/v1/requests/parse", files={"file": ("h.har", json.dumps(har).encode())}).json()

    assert result["requests"][0]["path"] == "/v1/{value}/items"
    assert result["left_out_secrets"] == 1
