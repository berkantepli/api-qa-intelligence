import json

import httpx

from app.domain.openapi import summarize_openapi

BASE_URL = "http://127.0.0.1:8000"

PET = {
    "type": "object",
    "required": ["name"],
    "properties": {"id": {"type": "integer", "example": 10}, "name": {"type": "string", "example": "Rex"}},
}


def contract(paths: dict, schemas: dict | None = None) -> dict:
    return {
        "openapi": "3.0.3",
        "info": {"title": "Pets", "version": "1.0"},
        "components": {"schemas": schemas or {"Pet": PET}},
        "paths": paths,
    }


def json_body(ref: str = "#/components/schemas/Pet") -> dict:
    return {"required": True, "content": {"application/json": {"schema": {"$ref": ref}}}}


def json_response(ref: str = "#/components/schemas/Pet", **extra) -> dict:
    return {"description": "ok", "content": {"application/json": {"schema": {"$ref": ref}}}, **extra}


ITEM = {"parameters": [{"name": "petId", "in": "path", "required": True, "schema": {"type": "integer"}}]}

PETSTORE_LIKE = contract({
    "/pet": {
        "post": {"requestBody": json_body(), "responses": {"200": json_response()}},
        "put": {"requestBody": json_body(), "responses": {"200": json_response()}},
    },
    "/pet/{petId}": {
        **ITEM,
        "get": {"responses": {"200": json_response(), "404": {"description": "missing"}}},
        "delete": {"responses": {"200": {"description": "deleted"}}},
    },
})


def only_flow(document: dict):
    flows = summarize_openapi(document).flows
    assert len(flows) == 1
    return flows[0]


def test_lifecycle_flow_is_inferred_from_the_create_response():
    flow = only_flow(PETSTORE_LIKE)

    assert flow.title == "Pet lifecycle"
    assert flow.source == "inferred"
    assert "'id' field of the create response" in flow.rationale
    assert [(step.role, step.method, step.path) for step in flow.steps] == [
        ("create", "POST", "/pet"),
        ("read", "GET", "/pet/{{petId}}"),
        ("update", "PUT", "/pet"),
        ("delete", "DELETE", "/pet/{{petId}}"),
        ("verify_deleted", "GET", "/pet/{{petId}}"),
    ]
    create, _, update, delete, gone = flow.steps
    assert [rule.model_dump() for rule in create.extract] == [
        {"variable": "petId", "source": "response_body", "pointer": "/id"}
    ]
    # A collection-level update names the record in its body.
    assert update.json_body == {"id": "{{petId}}", "name": "Rex"}
    assert delete.always_run is True
    assert gone.expected_status_codes == [404, 410]
    assert flow.missing_inputs == [] and flow.notes == []


def test_an_openapi_link_names_the_value_to_pass_on():
    document = contract({
        "/pets": {"post": {
            "requestBody": json_body(),
            "responses": {"201": json_response("#/components/schemas/Created", links={
                "GetPet": {"operationId": "getPet", "parameters": {"path.petId": "$response.body#/data/key"}},
            })},
        }},
        "/pets/{petId}": {**ITEM, "get": {"operationId": "getPet", "responses": {"200": json_response()}}},
    }, schemas={"Pet": PET, "Created": {"type": "object", "properties": {"data": {"type": "object"}}}})

    flow = only_flow(document)

    assert flow.source == "openapi_link"
    assert "'GetPet' link" in flow.rationale
    assert flow.steps[0].extract[0].pointer == "/data/key"
    assert flow.steps[0].expected_status_codes == [201]
    assert summarize_openapi(document).operations[0].links[0].parameters == {"petId": "$response.body#/data/key"}


def test_titles_name_one_record_of_a_plural_collection():
    flow = only_flow(contract({
        "/categories": {"post": {"requestBody": json_body(), "responses": {"200": json_response()}}},
        "/categories/{categoryId}": {"delete": {"responses": {"204": {"description": "deleted"}}}},
    }))

    assert flow.title == "Category lifecycle"
    assert flow.steps[0].title == "Create a category"


def test_a_value_sent_in_the_create_body_is_used_when_the_response_is_not_documented():
    user = {"type": "object", "properties": {"username": {"type": "string", "example": "qa"}}}
    document = contract({
        "/users": {"post": {"requestBody": json_body("#/components/schemas/User"), "responses": {"201": {"description": "ok"}}}},
        "/users/{username}": {
            "parameters": [{"name": "username", "in": "path", "required": True, "schema": {"type": "string"}}],
            "get": {"responses": {"200": {"description": "ok"}}},
            "put": {"requestBody": json_body("#/components/schemas/User"), "responses": {"200": {"description": "ok"}}},
        },
    }, schemas={"User": user})

    flow = only_flow(document)

    assert flow.steps[0].extract[0].model_dump() == {"variable": "username", "source": "request_body", "pointer": "/username"}
    assert flow.steps[2].path == "/users/{{username}}"
    assert flow.steps[2].json_body == {"username": "{{username}}"}
    assert "is not cleaned up" in flow.notes[0]


def test_an_undocumented_create_response_is_assumed_to_return_an_id(sample_spec):
    flow = only_flow(sample_spec)

    assert flow.steps[0].extract[0].pointer == "/id"
    assert "(not documented)" in flow.rationale


def test_no_flow_when_nothing_links_the_created_record_to_the_item_path():
    document = contract({
        "/pages": {"post": {"requestBody": json_body(), "responses": {"200": json_response()}}},
        # A {slug} is not an id, so the response's "id" field is not used for it.
        "/pages/{slug}": {
            "parameters": [{"name": "slug", "in": "path", "required": True, "schema": {"type": "string"}}],
            "get": {"responses": {"200": json_response()}},
        },
        "/tags": {"post": {"requestBody": json_body(), "responses": {"200": json_response()}}},
    })

    assert summarize_openapi(document).flows == []


def test_a_parent_path_parameter_is_reported_as_missing():
    parent = {"name": "ownerId", "in": "path", "required": True, "schema": {"type": "integer"}}
    document = contract({
        "/owners/{ownerId}/pets": {"parameters": [parent], "post": {"requestBody": json_body(), "responses": {"200": json_response()}}},
        "/owners/{ownerId}/pets/{petId}": {
            "parameters": [parent, ITEM["parameters"][0]],
            "delete": {"responses": {"204": {"description": "deleted"}}},
        },
    })

    flow = only_flow(document)

    assert flow.missing_inputs == ["ownerId"]
    assert flow.steps[1].path == "/owners/{ownerId}/pets/{{petId}}"


def test_suggest_route_infers_flows_for_a_saved_overview(client):
    overview = summarize_openapi(PETSTORE_LIKE).model_dump()

    response = client.post("/api/v1/flows/suggest", json={"operations": overview["operations"]})

    assert response.status_code == 200
    assert response.json()["flows"] == overview["flows"]


# --- Running flows ------------------------------------------------------------------------------


def run(client, steps, **overrides):
    return client.post("/api/v1/flows/execute", json={"base_url": BASE_URL, "steps": steps, **overrides})


def petstore_steps():
    return only_flow(PETSTORE_LIKE).model_dump()["steps"]


def fake_pet_api(fail: dict | None = None):
    """A small in-memory pet API; `fail` maps "METHOD /path" to a status to answer with instead."""
    pets: dict[str, dict] = {}

    def handle(request: httpx.Request) -> httpx.Response:
        route = f"{request.method} {request.url.path}"
        if fail and route in fail:
            return httpx.Response(fail[route], json={"message": "boom"})
        if route == "POST /pet":
            pet = {**json.loads(request.content), "id": 7}
            pets["7"] = pet
            return httpx.Response(200, json=pet)
        if route == "PUT /pet":
            pet = json.loads(request.content)
            pets[str(pet["id"])] = pet
            return httpx.Response(200, json=pet)
        pet_id = request.url.path.rsplit("/", 1)[-1]
        if pet_id not in pets:
            return httpx.Response(404, json={"message": "not found"})
        if request.method == "DELETE":
            del pets[pet_id]
            return httpx.Response(200)
        return httpx.Response(200, json=pets[pet_id])

    return handle


def test_a_flow_passes_the_created_id_to_every_later_step(client, mock_http):
    mock_http.respond_with(fake_pet_api())

    result = run(client, petstore_steps()).json()

    assert result["result"] == "PASS"
    assert (result["total"], result["passed"]) == (5, 5)
    assert [str(request.url) for request in mock_http.requests] == [
        f"{BASE_URL}/pet", f"{BASE_URL}/pet/7", f"{BASE_URL}/pet", f"{BASE_URL}/pet/7", f"{BASE_URL}/pet/7",
    ]
    # A body string that is only a placeholder keeps the saved value's type.
    assert json.loads(mock_http.requests[2].content)["id"] == 7
    assert result["steps"][0]["saved_values"] == {"petId": 7}
    assert result["steps"][4]["check"]["response_status"] == 404


def test_cleanup_still_runs_after_a_step_fails(client, mock_http):
    mock_http.respond_with(fake_pet_api(fail={"GET /pet/7": 500}))

    result = run(client, petstore_steps()).json()

    assert result["result"] == "FAIL"
    assert [step["status"] for step in result["steps"]] == ["PASS", "FAIL", "SKIPPED", "PASS", "SKIPPED"]
    assert result["steps"][2]["reason"] == "Skipped because an earlier step did not pass."
    assert mock_http.requests[-1].method == "DELETE"


def test_cleanup_is_skipped_when_nothing_was_created(client, mock_http):
    mock_http.respond_with(fake_pet_api(fail={"POST /pet": 400}))

    result = run(client, petstore_steps()).json()

    assert [step["status"] for step in result["steps"]] == ["FAIL", "SKIPPED", "SKIPPED", "SKIPPED", "SKIPPED"]
    assert result["steps"][3]["reason"] == "Skipped because no earlier step saved petId."
    assert len(mock_http.requests) == 1


def test_a_missing_value_fails_the_step_that_should_provide_it(client, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json={"name": "Rex"}))

    result = run(client, petstore_steps()).json()

    assert result["steps"][0]["status"] == "FAIL"
    assert result["steps"][0]["reason"] == "Could not save {{petId}}: /id in the response body has no value."
    assert result["skipped"] == 4


def test_saved_values_are_encoded_in_the_path_and_cannot_escape_it(client, mock_http):
    steps = [
        {"title": "Create", "method": "POST", "path": "/pet", "extract": [{"variable": "petId", "pointer": "/id"}]},
        {"title": "Read", "method": "GET", "path": "/pet/{{petId}}"},
    ]
    mock_http.respond_with(lambda request: httpx.Response(200, json={"id": "a b?c"}))
    assert str(mock_http.requests[-1].url if run(client, steps).json()["result"] == "PASS" else "") == f"{BASE_URL}/pet/a%20b%3Fc"

    mock_http.respond_with(lambda request: httpx.Response(200, json={"id": ".."}))
    result = run(client, steps).json()

    assert result["result"] == "ERROR"
    assert "cannot be used in this request" in result["steps"][1]["reason"]
    assert str(mock_http.requests[-1].url) == f"{BASE_URL}/pet"


def test_shared_headers_are_sent_with_every_step_and_redacted(client, mock_http):
    steps = [{"title": "Log in", "method": "POST", "path": "/login", "extract": [{"variable": "token", "pointer": "/token"}]},
             {"title": "Profile", "method": "GET", "path": "/me", "headers": {"X-Session": "{{token}}"}}]
    mock_http.respond_with(lambda request: httpx.Response(200, json={"token": "issued-secret"}))

    result = run(client, steps, headers={"Authorization": "Bearer header-secret"}).json()

    assert all(request.headers["Authorization"] == "Bearer header-secret" for request in mock_http.requests)
    assert mock_http.requests[1].headers["X-Session"] == "issued-secret"
    assert result["steps"][0]["saved_values"] == {"token": "[REDACTED]"}
    assert "header-secret" not in json.dumps(result) and "issued-secret" not in json.dumps(result)


def test_a_flow_must_save_a_value_before_using_it(client, mock_http):
    response = run(client, [{"title": "Read", "method": "GET", "path": "/pet/{{petId}}"}])

    assert response.status_code == 422
    assert "Step 1 uses {{petId}}, which no earlier step saves." in response.text
    assert mock_http.requests == []


def test_a_flow_with_an_unfilled_path_parameter_is_refused(client, mock_http):
    response = run(client, [{"title": "Read", "method": "GET", "path": "/owners/{ownerId}/pets"}])

    assert response.status_code == 422
    assert "Step 1: fill in the path parameter(s) ownerId." in response.text
