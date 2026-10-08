from app.domain.openapi import summarize_openapi
from app.domain.swagger2 import convert_swagger2

SWAGGER = {
    "swagger": "2.0",
    "info": {"title": "Pets", "version": "1.0"},
    "host": "pets.test",
    "basePath": "/v1/",
    "schemes": ["https"],
    "consumes": ["application/json"],
    "produces": ["application/json"],
    "securityDefinitions": {
        "key": {"type": "apiKey", "in": "header", "name": "X-Key"},
        "login": {"type": "basic"},
        "oauth": {"type": "oauth2", "flow": "accessCode", "authorizationUrl": "https://auth.test/a", "tokenUrl": "https://auth.test/t", "scopes": {"read": "Read"}},
    },
    "parameters": {"limit": {"name": "limit", "in": "query", "type": "integer", "maximum": 50, "x-example": 10}},
    "definitions": {
        "Pet": {"type": "object", "required": ["name"], "properties": {"name": {"type": "string"}, "owner": {"$ref": "#/definitions/Owner"}}},
        "Owner": {"type": "object", "properties": {"id": {"type": "integer"}}},
    },
    "paths": {
        "/pets": {
            "get": {
                "security": [{"key": []}],
                "parameters": [{"$ref": "#/parameters/limit"}, {"name": "status", "in": "query", "type": "array", "items": {"type": "string", "enum": ["available", "sold"]}}],
                "responses": {"200": {"description": "ok", "schema": {"type": "array", "items": {"$ref": "#/definitions/Pet"}}}, "401": {"description": "no"}},
            },
            "post": {
                "parameters": [{"name": "pet", "in": "body", "required": True, "schema": {"$ref": "#/definitions/Pet"}}],
                "responses": {"201": {"description": "created"}},
            },
        },
        "/pets/{id}/photo": {
            "parameters": [{"name": "id", "in": "path", "required": True, "type": "string"}],
            "post": {
                "consumes": ["multipart/form-data"],
                "parameters": [
                    {"name": "file", "in": "formData", "type": "file", "required": True},
                    {"name": "note", "in": "formData", "type": "string"},
                ],
                "responses": {"200": {"description": "ok"}},
            },
        },
    },
}


def test_servers_components_and_security_are_converted():
    converted = convert_swagger2(SWAGGER)

    assert converted["openapi"].startswith("3.")
    assert converted["servers"] == [{"url": "https://pets.test/v1"}]
    assert converted["components"]["schemas"]["Pet"]["properties"]["owner"] == {"$ref": "#/components/schemas/Owner"}
    assert converted["components"]["securitySchemes"]["login"] == {"type": "http", "scheme": "basic"}
    assert converted["components"]["securitySchemes"]["oauth"]["flows"]["authorizationCode"]["tokenUrl"] == "https://auth.test/t"
    assert converted["components"]["parameters"]["limit"]["schema"] == {"type": "integer", "maximum": 50}


def test_operations_get_parameters_request_bodies_and_response_schemas():
    paths = convert_swagger2(SWAGGER)["paths"]

    assert paths["/pets"]["get"]["parameters"][0] == {"$ref": "#/components/parameters/limit"}
    assert paths["/pets"]["get"]["responses"]["200"]["content"]["application/json"]["schema"]["items"] == {"$ref": "#/components/schemas/Pet"}
    assert paths["/pets"]["post"]["requestBody"] == {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}}}
    upload = paths["/pets/{id}/photo"]["post"]["requestBody"]["content"]["multipart/form-data"]["schema"]
    assert upload["properties"]["file"] == {"type": "string", "format": "binary"}
    assert upload["required"] == ["file"]
    assert paths["/pets/{id}/photo"]["parameters"][0]["schema"] == {"type": "string"}


def test_a_swagger_document_imports_like_an_openapi_one():
    overview = summarize_openapi(SWAGGER)
    operations = {f"{item.method} {item.path}": item for item in overview.operations}

    assert overview.openapi_version == "2.0 (Swagger, converted)"
    assert overview.servers == ["https://pets.test/v1"]
    pets = operations["GET /pets"]
    assert {(p.name, p.location, p.credential) for p in pets.parameters} == {("limit", "query", False), ("status", "query", False), ("X-Key", "header", True)}
    # An array parameter is prefilled with one documented item value.
    assert next(p for p in pets.parameters if p.name == "status").example == "available"
    assert pets.response_schemas["200"]["items"]["required"] == ["name"]
    assert operations["POST /pets"].request_body_content_type == "application/json"
    assert {field.name: field.is_file for field in operations["POST /pets/{id}/photo"].request_body_fields} == {"file": True, "note": False}
