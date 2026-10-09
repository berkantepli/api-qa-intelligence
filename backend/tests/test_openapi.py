import pytest

from app.domain.openapi import OpenApiDocumentError, summarize_openapi


def operation(overview, method, path):
    return next(item for item in overview.operations if item.method == method and item.path == path)


def scenario(op, title):
    return next(item for item in op.scenarios if item.title == title)


@pytest.mark.parametrize(
    ("document", "message"),
    [
        ([], "root must be"),
        ({"swagger": "1.2"}, "OpenAPI 3.x or Swagger 2.0"),
        ({"swagger": "2.0", "paths": {}}, "'info' object"),
        ({"openapi": "3.0.0"}, "'info' object"),
        ({"openapi": "3.0.0", "info": {"version": "1"}}, "title"),
        ({"openapi": "3.0.0", "info": {"title": "A", "version": "1"}}, "'paths' object"),
    ],
)
def test_rejects_unsupported_documents(document, message):
    with pytest.raises(OpenApiDocumentError, match=message):
        summarize_openapi(document)


def test_summarizes_operations_and_servers(sample_spec):
    overview = summarize_openapi(sample_spec)

    assert (overview.title, overview.version, overview.openapi_version) == ("Pets", "1.0", "3.0.3")
    assert overview.servers == ["http://127.0.0.1:8000"]
    assert overview.operation_count == 6
    assert {(item.method, item.path) for item in overview.operations} == {
        ("GET", "/pets"),
        ("POST", "/pets"),
        ("GET", "/pets/{id}"),
        ("DELETE", "/pets/{id}"),
        ("POST", "/upload"),
        ("POST", "/xml"),
    }


def test_resolves_parameters_and_security_credentials(sample_spec):
    overview = summarize_openapi(sample_spec)

    list_pets = {param.name: param for param in operation(overview, "GET", "/pets").parameters}
    assert list_pets["limit"].location == "query"
    assert list_pets["limit"].example == 10
    assert list_pets["limit"].required is False
    assert list_pets["X-Key"].location == "header"
    assert list_pets["X-Key"].required is False
    assert list_pets["X-Key"].credential is True
    assert list_pets["limit"].credential is False

    create_pet = {param.name for param in operation(overview, "POST", "/pets").parameters}
    assert create_pet == {"Authorization"}

    get_pet = operation(overview, "GET", "/pets/{id}").parameters
    path_param = next(param for param in get_pet if param.name == "id")
    assert (path_param.location, path_param.required, path_param.example) == ("path", True, "p1")


def test_documented_credential_parameter_keeps_its_required_flag():
    document = {
        "openapi": "3.0.0",
        "info": {"title": "Keys", "version": "1"},
        "components": {"securitySchemes": {"key": {"type": "apiKey", "in": "header", "name": "api_key"}}},
        "paths": {
            "/items": {
                "get": {
                    "security": [{"key": []}],
                    "parameters": [{"name": "api_key", "in": "header", "required": True, "schema": {"type": "string"}}],
                    "responses": {"200": {}},
                }
            }
        },
    }

    (parameter,) = summarize_openapi(document).operations[0].parameters
    assert (parameter.name, parameter.required, parameter.credential) == ("api_key", True, True)


def test_json_body_scenarios_have_runnable_examples(sample_spec):
    create_pet = operation(summarize_openapi(sample_spec), "POST", "/pets")

    assert create_pet.request_body_content_type == "application/json"
    assert create_pet.request_body_required is True
    assert {field.name for field in create_pet.request_body_fields if field.required} == {"name", "age"}

    valid = scenario(create_pet, "Valid request").request_example
    assert valid.expected_status_codes == [201]
    assert valid.json_body["email"] == "qa@example.com"
    assert valid.json_body["kind"] == "cat"
    assert 2 <= len(valid.json_body["name"]) <= 20

    missing = scenario(create_pet, "Omit a required request field").request_example
    assert "name" not in missing.json_body
    assert missing.expected_status_codes == [422]

    assert scenario(create_pet, "Check boundary values for age").request_example.json_body["age"] == 0
    assert scenario(create_pet, "Send invalid email").request_example.json_body["email"] == "not-a-valid-value"
    enum_check = scenario(create_pet, "Send an undocumented value for kind").request_example
    assert enum_check.json_body["kind"] == "__invalid_enum_value__"


def test_omitted_required_parameter_scenario(sample_spec):
    list_pets = operation(summarize_openapi(sample_spec), "GET", "/pets")

    omit = scenario(list_pets, "Omit a required parameter").request_example
    assert omit.omitted_parameters == [{"name": "owner", "location": "query"}]
    assert 404 in omit.expected_status_codes


def test_form_body_fields_and_example(sample_spec):
    upload = operation(summarize_openapi(sample_spec), "POST", "/upload")

    fields = {field.name: field for field in upload.request_body_fields}
    assert upload.request_body_content_type == "multipart/form-data"
    assert fields["file"].is_file is True
    assert fields["note"].is_file is False

    valid = scenario(upload, "Valid request").request_example
    assert valid.form_body is True
    assert valid.form_fields == {"note": "hi"}


def test_unsupported_media_type_is_not_runnable(sample_spec):
    xml = operation(summarize_openapi(sample_spec), "POST", "/xml")

    assert scenario(xml, "Valid request").request_example is None


def test_security_scenario_follows_operation_security(sample_spec):
    overview = summarize_openapi(sample_spec)

    protected = operation(overview, "GET", "/pets")
    public = operation(overview, "DELETE", "/pets/{id}")
    assert any(item.category == "security_minded" for item in protected.scenarios)
    assert not any(item.category == "security_minded" for item in public.scenarios)
    unauthenticated = scenario(protected, "Call without authentication").request_example
    assert unauthenticated.omitted_parameters == [{"name": "X-Key", "location": "header"}]
    assert unauthenticated.expected_status_codes == [401, 403]


def test_optional_authentication_is_not_checked_as_required():
    document = {
        "openapi": "3.0.0",
        "info": {"title": "Optional", "version": "1"},
        "components": {"securitySchemes": {"bearer": {"type": "http", "scheme": "bearer"}}},
        "paths": {"/items": {"get": {"security": [{"bearer": []}, {}], "responses": {"200": {}, "401": {}}}}},
    }

    (item,) = summarize_openapi(document).operations
    assert scenario(item, "Call without authentication").request_example is None


def test_circular_references_do_not_recurse_forever():
    document = {
        "openapi": "3.0.0",
        "info": {"title": "Loop", "version": "1"},
        "components": {
            "schemas": {"Node": {"type": "object", "properties": {"child": {"$ref": "#/components/schemas/Node"}}}}
        },
        "paths": {
            "/nodes": {
                "post": {
                    "requestBody": {"content": {"application/json": {"schema": {"$ref": "#/components/schemas/Node"}}}},
                    "responses": {"200": {}},
                }
            }
        },
    }

    create_node = summarize_openapi(document).operations[0]
    assert [field.name for field in create_node.request_body_fields] == ["child"]
    assert scenario(create_node, "Valid request").request_example.json_body == {"child": None}



def test_fields_carry_their_schema_and_only_documented_examples():
    document = {
        "openapi": "3.0.0",
        "info": {"title": "Samples", "version": "1"},
        "paths": {
            "/orders": {
                "post": {
                    "parameters": [{"name": "limit", "in": "query", "schema": {"type": "integer", "minimum": 5}}],
                    "requestBody": {"content": {"application/json": {"schema": {
                        "type": "object",
                        "properties": {
                            "quantity": {"type": "integer", "example": 7},
                            "shipDate": {"type": "string", "format": "date-time"},
                            "tags": {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}}}},
                        },
                    }}}},
                    "responses": {"200": {}},
                }
            }
        },
    }

    operation = summarize_openapi(document).operations[0]
    fields = {field.name: field for field in operation.request_body_fields}

    assert fields["quantity"].example == 7
    assert fields["shipDate"].example is None
    assert fields["shipDate"].value_schema == {"type": "string", "format": "date-time"}
    assert fields["tags"].value_schema == {"type": "array", "items": {"type": "object", "properties": {"name": {"type": "string"}}}}
    assert operation.parameters[0].example is None
    assert operation.parameters[0].value_schema == {"type": "integer", "minimum": 5}


def test_deeply_nested_refs_cannot_hang_an_import():
    """Ten properties referencing the next schema over six levels would inline a million nodes."""
    import time

    schemas = {"L6": {"type": "string"}}
    for level in range(5, -1, -1):
        schemas[f"L{level}"] = {
            "type": "object",
            "properties": {f"p{index}": {"$ref": f"#/components/schemas/L{level + 1}"} for index in range(10)},
        }
    reference = {"$ref": "#/components/schemas/L0"}
    document = {
        "openapi": "3.0.0",
        "info": {"title": "Nested", "version": "1"},
        "components": {"schemas": schemas},
        "paths": {"/a": {"post": {
            "requestBody": {"content": {"application/json": {"schema": reference}}},
            "responses": {"200": {"content": {"application/json": {"schema": reference}}}},
        }}},
    }

    started = time.perf_counter()
    summarize_openapi(document)
    assert time.perf_counter() - started < 2
