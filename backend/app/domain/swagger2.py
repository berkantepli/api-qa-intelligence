"""Converts a Swagger 2.0 document to OpenAPI 3.0 so the rest of the app reads one format.

The conversion covers what the app uses: servers (host, basePath, schemes), path and operation
parameters, body and formData parameters as request bodies, response schemas, shared
definitions/parameters/responses, and security definitions. Vendor extensions are kept.
"""

import copy
from collections.abc import Mapping
from typing import Any

PARAMETER_SCHEMA_KEYS = (
    "type", "format", "items", "enum", "default", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum",
    "minLength", "maxLength", "pattern", "minItems", "maxItems", "uniqueItems", "multipleOf",
)
FORM_TYPES = ("multipart/form-data", "application/x-www-form-urlencoded")


def is_swagger2(document: Any) -> bool:
    return isinstance(document, Mapping) and str(document.get("swagger", "")).startswith("2.")


def _rewrite_refs(node: Any) -> Any:
    """Points Swagger 2.0 $refs at their OpenAPI 3 locations."""
    if isinstance(node, list):
        return [_rewrite_refs(item) for item in node]
    if not isinstance(node, Mapping):
        return node
    converted = {}
    for key, value in node.items():
        if key == "$ref" and isinstance(value, str):
            value = (
                value.replace("#/definitions/", "#/components/schemas/")
                .replace("#/parameters/", "#/components/parameters/")
                .replace("#/responses/", "#/components/responses/")
            )
        elif key == "type" and value == "file":
            # A Swagger 2.0 file maps to a binary string in OpenAPI 3.
            converted["format"] = "binary"
            value = "string"
        converted[key] = _rewrite_refs(value)
    return converted


def _parameter_schema(parameter: Mapping[str, Any]) -> dict[str, Any]:
    return _rewrite_refs({key: parameter[key] for key in PARAMETER_SCHEMA_KEYS if key in parameter})


def _convert_parameter(parameter: Mapping[str, Any]) -> dict[str, Any]:
    if "$ref" in parameter:
        return _rewrite_refs(dict(parameter))
    converted = {key: parameter[key] for key in ("name", "in", "description", "required", "x-example") if key in parameter}
    converted["schema"] = _parameter_schema(parameter)
    if "x-example" in parameter:
        converted["example"] = parameter["x-example"]
    return converted


def _media_types(primary: Any, fallback: Any, default: list[str]) -> list[str]:
    for value in (primary, fallback):
        if isinstance(value, list) and value:
            return [str(item) for item in value]
    return default


def _request_body(parameters: list[Mapping[str, Any]], consumes: list[str]) -> dict[str, Any] | None:
    body = next((p for p in parameters if p.get("in") == "body"), None)
    if body is not None:
        json_types = [media for media in consumes if "json" in media] or ["application/json"]
        return {
            "required": bool(body.get("required")),
            **({"description": body["description"]} if "description" in body else {}),
            "content": {media: {"schema": _rewrite_refs(body.get("schema", {}))} for media in json_types},
        }
    form = [p for p in parameters if p.get("in") == "formData"]
    if not form:
        return None
    has_file = any(p.get("type") == "file" for p in form)
    media = next((m for m in consumes if m in FORM_TYPES), "multipart/form-data" if has_file else FORM_TYPES[1])
    schema = {
        "type": "object",
        "properties": {
            str(p.get("name")): {**_parameter_schema(p), **({"description": p["description"]} if "description" in p else {})}
            for p in form
        },
    }
    required = [str(p.get("name")) for p in form if p.get("required")]
    if required:
        schema["required"] = required
    return {"required": bool(required), "content": {media: {"schema": schema}}}


def _response(response: Any, produces: list[str]) -> Any:
    if not isinstance(response, Mapping):
        return response
    if "$ref" in response:
        return _rewrite_refs(dict(response))
    converted = {key: copy.deepcopy(value) for key, value in response.items() if key not in {"schema", "examples"}}
    converted.setdefault("description", "")
    if "schema" in response:
        json_types = [media for media in produces if "json" in media] or ["application/json"]
        converted["content"] = {media: {"schema": _rewrite_refs(response["schema"])} for media in json_types}
    return converted


def _security_scheme(definition: Mapping[str, Any]) -> dict[str, Any]:
    kind = definition.get("type")
    description = {"description": definition["description"]} if "description" in definition else {}
    if kind == "basic":
        return {"type": "http", "scheme": "basic", **description}
    if kind == "apiKey":
        return {"type": "apiKey", "name": definition.get("name"), "in": definition.get("in"), **description}
    if kind == "oauth2":
        flow_names = {"implicit": "implicit", "password": "password", "application": "clientCredentials", "accessCode": "authorizationCode"}
        flow = {key: definition[key] for key in ("authorizationUrl", "tokenUrl") if key in definition}
        flow["scopes"] = definition.get("scopes", {})
        return {"type": "oauth2", "flows": {flow_names.get(definition.get("flow"), "implicit"): flow}, **description}
    return dict(definition)


def convert_swagger2(document: Mapping[str, Any]) -> dict[str, Any]:
    consumes = _media_types(document.get("consumes"), None, ["application/json"])
    produces = _media_types(document.get("produces"), None, ["application/json"])
    converted: dict[str, Any] = {
        "openapi": "3.0.3",
        "info": copy.deepcopy(document.get("info", {})),
        "x-converted-from": f"Swagger {document.get('swagger')}",
    }
    host = document.get("host")
    if isinstance(host, str) and host:
        schemes = document.get("schemes") or ["https"]
        base_path = str(document.get("basePath", "") or "").rstrip("/")
        converted["servers"] = [{"url": f"{scheme}://{host}{base_path}"} for scheme in schemes]
    elif document.get("basePath"):
        converted["servers"] = [{"url": str(document["basePath"]).rstrip("/") or "/"}]
    if isinstance(document.get("security"), list):
        converted["security"] = copy.deepcopy(document["security"])
    if isinstance(document.get("tags"), list):
        converted["tags"] = copy.deepcopy(document["tags"])

    components: dict[str, Any] = {}
    if isinstance(document.get("definitions"), Mapping):
        components["schemas"] = _rewrite_refs(document["definitions"])
    if isinstance(document.get("parameters"), Mapping):
        components["parameters"] = {
            name: _convert_parameter(parameter) for name, parameter in document["parameters"].items()
            if isinstance(parameter, Mapping) and parameter.get("in") not in {"body", "formData"}
        }
    if isinstance(document.get("responses"), Mapping):
        components["responses"] = {name: _response(response, produces) for name, response in document["responses"].items()}
    if isinstance(document.get("securityDefinitions"), Mapping):
        components["securitySchemes"] = {
            name: _security_scheme(definition) for name, definition in document["securityDefinitions"].items()
            if isinstance(definition, Mapping)
        }
    if components:
        converted["components"] = components

    shared_parameters = document.get("parameters") if isinstance(document.get("parameters"), Mapping) else {}

    def resolve_shared(parameter: Any) -> Any:
        # Shared body and formData parameters have no OpenAPI 3 parameter equivalent, so inline them.
        reference = parameter.get("$ref") if isinstance(parameter, Mapping) else None
        if isinstance(reference, str) and reference.startswith("#/parameters/"):
            target = shared_parameters.get(reference.split("/")[-1])
            if isinstance(target, Mapping) and target.get("in") in {"body", "formData"}:
                return target
        return parameter

    paths: dict[str, Any] = {}
    for path, item in (document.get("paths") or {}).items():
        if not isinstance(item, Mapping):
            continue
        path_parameters = [resolve_shared(p) for p in item.get("parameters", []) if isinstance(p, Mapping)]
        converted_item: dict[str, Any] = {}
        if path_parameters:
            converted_item["parameters"] = [
                _convert_parameter(p) for p in path_parameters if p.get("in") not in {"body", "formData"}
            ]
        for method, operation in item.items():
            if method == "parameters" or not isinstance(operation, Mapping):
                if method.startswith("x-"):
                    converted_item[method] = copy.deepcopy(operation)
                continue
            parameters = [resolve_shared(p) for p in operation.get("parameters", []) if isinstance(p, Mapping)]
            all_parameters = parameters + [p for p in path_parameters if p.get("in") in {"body", "formData"}]
            new_operation = {
                key: copy.deepcopy(value) for key, value in operation.items()
                if key not in {"parameters", "responses", "consumes", "produces", "schemes"}
            }
            plain = [_convert_parameter(p) for p in parameters if p.get("in") not in {"body", "formData"}]
            if plain:
                new_operation["parameters"] = plain
            body = _request_body(all_parameters, _media_types(operation.get("consumes"), document.get("consumes"), consumes))
            if body:
                new_operation["requestBody"] = body
            operation_produces = _media_types(operation.get("produces"), document.get("produces"), produces)
            new_operation["responses"] = {
                str(code): _response(response, operation_produces) for code, response in (operation.get("responses") or {}).items()
            }
            converted_item[method] = new_operation
        paths[path] = converted_item
    converted["paths"] = paths
    return converted
