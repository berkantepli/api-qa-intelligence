from collections.abc import Mapping
from typing import Any

from pydantic import AnyHttpUrl, BaseModel, Field

HTTP_METHODS = {"get", "post", "put", "patch", "delete", "head", "options", "trace"}
FORM_MEDIA_TYPES = ("multipart/form-data", "application/x-www-form-urlencoded")
BOUNDARY_KEYS = ("minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems")


class ScenarioRequestExample(BaseModel):
    method: str
    path: str
    query_params: dict[str, str] = Field(default_factory=dict)
    form_body: bool = False
    form_fields: dict[str, str] = Field(default_factory=dict)
    omitted_parameters: list[dict[str, str]] = Field(default_factory=list)
    json_body: Any = None
    expected_status_codes: list[int] = Field(default_factory=lambda: [200])


class ApiParameter(BaseModel):
    name: str
    location: str
    required: bool = False
    description: str | None = None
    example: Any = None
    field_type: str = "string"


class ApiBodyField(BaseModel):
    name: str
    required: bool = False
    field_type: str = "string"
    description: str | None = None
    example: Any = None
    is_file: bool = False
    multiple: bool = False


class QaScenario(BaseModel):
    category: str
    title: str
    rationale: str
    review_required: bool = False
    source: str = "contract"
    request_example: ScenarioRequestExample | None = None


class ApiOperation(BaseModel):
    method: str
    path: str
    operation_id: str | None = None
    summary: str | None = None
    tags: list[str] = Field(default_factory=list)
    parameters: list[ApiParameter] = Field(default_factory=list)
    request_body_content_type: str | None = None
    request_body_required: bool = False
    request_body_fields: list[ApiBodyField] = Field(default_factory=list)
    scenarios: list[QaScenario] = Field(default_factory=list)


class ApiOverview(BaseModel):
    title: str
    version: str
    openapi_version: str
    servers: list[str] = Field(default_factory=list)
    operation_count: int
    operations: list[ApiOperation]


class SpecUrlRequest(BaseModel):
    url: AnyHttpUrl


class OpenApiDocumentError(ValueError):
    """Raised when an uploaded document is not a supported OpenAPI document."""


def summarize_openapi(document: Any) -> ApiOverview:
    if not isinstance(document, Mapping):
        raise OpenApiDocumentError("The document root must be a JSON or YAML object.")

    openapi_version = document.get("openapi")
    if not isinstance(openapi_version, str) or not openapi_version.startswith("3."):
        raise OpenApiDocumentError("An OpenAPI 3.x document is required.")

    info = document.get("info")
    if not isinstance(info, Mapping):
        raise OpenApiDocumentError("The OpenAPI document must include an 'info' object.")

    title = info.get("title")
    version = info.get("version")
    if not isinstance(title, str) or not title.strip():
        raise OpenApiDocumentError("The OpenAPI 'info' object must include a title.")
    if not isinstance(version, str) or not version.strip():
        raise OpenApiDocumentError("The OpenAPI 'info' object must include a version.")

    paths = document.get("paths")
    if not isinstance(paths, Mapping):
        raise OpenApiDocumentError("The OpenAPI document must include a 'paths' object.")

    servers = document.get("servers", [])
    server_urls = [
        server["url"].strip()
        for server in servers
        if isinstance(server, Mapping) and isinstance(server.get("url"), str) and server["url"].strip()
    ] if isinstance(servers, list) else []

    operations: list[ApiOperation] = []
    global_security = document.get("security", [])
    for path, path_item in paths.items():
        if not isinstance(path, str) or not isinstance(path_item, Mapping):
            continue
        for method, details in path_item.items():
            if not isinstance(method, str) or method.lower() not in HTTP_METHODS:
                continue
            if not isinstance(details, Mapping):
                continue

            tags = details.get("tags", [])
            request_body = details.get("requestBody")
            body_content_type = _request_body_content_type(request_body, document)
            body_fields = _request_body_fields(request_body, document)
            operations.append(
                ApiOperation(
                    method=method.upper(),
                    path=path,
                    operation_id=_optional_string(details.get("operationId")),
                    summary=_optional_string(details.get("summary")),
                    tags=[tag for tag in tags if isinstance(tag, str)] if isinstance(tags, list) else [],
                    parameters=_operation_parameters(path_item, details, global_security, document),
                    request_body_content_type=body_content_type,
                    request_body_required=_request_body_required(request_body, document),
                    request_body_fields=body_fields,
                    scenarios=_generate_scenarios(
                        method.upper(), path, details, global_security, document, body_content_type, body_fields
                    ),
                )
            )

    return ApiOverview(
        title=title.strip(),
        version=version.strip(),
        openapi_version=openapi_version,
        servers=server_urls,
        operation_count=len(operations),
        operations=operations,
    )


def _optional_string(value: Any) -> str | None:
    return value.strip() if isinstance(value, str) and value.strip() else None


def _generate_scenarios(
    method: str,
    path: str,
    operation: Mapping[str, Any],
    global_security: Any,
    document: Mapping[str, Any],
    body_content_type: str | None,
    body_fields: list[ApiBodyField],
) -> list[QaScenario]:
    body_schema = _request_body_schema(operation.get("requestBody"), document)
    is_form_body = bool(body_content_type and body_content_type.lower().startswith(FORM_MEDIA_TYPES))
    success_codes = _status_codes(operation.get("responses"), 2) or [200]
    error_codes = _status_codes(operation.get("responses"), 4) or [400, 422]
    request_is_supported = operation.get("requestBody") is None or body_schema is not None or is_form_body
    valid_body = _example_from_schema(body_schema) if body_schema is not None else None
    form_fields = {
        field.name: str(field.example)
        for field in body_fields
        if not field.is_file and field.example is not None
    }

    def json_body_example(json_body: Any, expected_status_codes: list[int]) -> ScenarioRequestExample | None:
        if not request_is_supported or not isinstance(valid_body, Mapping):
            return None
        return ScenarioRequestExample(
            method=method, path=path, json_body=json_body, expected_status_codes=expected_status_codes
        )

    scenarios = [
        QaScenario(
            category="happy_path",
            title="Valid request",
            rationale="Send a request that follows the documented parameters and request schema, then check a documented success response.",
            review_required=True,
            request_example=(
                ScenarioRequestExample(
                    method=method,
                    path=path,
                    form_body=is_form_body,
                    form_fields=form_fields if is_form_body else {},
                    json_body=valid_body,
                    expected_status_codes=success_codes,
                )
                if request_is_supported
                else None
            ),
        )
    ]

    parameters = operation.get("parameters", [])
    required_parameters = [
        parameter
        for parameter in parameters
        if isinstance(parameter, Mapping) and parameter.get("required") is True
    ] if isinstance(parameters, list) else []
    if required_parameters:
        names = ", ".join(str(parameter.get("name", "parameter")) for parameter in required_parameters)
        scenarios.append(
            QaScenario(
                category="negative",
                title="Omit a required parameter",
                rationale=f"Send the request without required parameter(s): {names}; check that the API rejects it with a validation response.",
                review_required=True,
                request_example=ScenarioRequestExample(
                    method=method,
                    path=path,
                    omitted_parameters=[
                        {"name": str(parameter.get("name", "")), "location": str(parameter.get("in", ""))}
                        for parameter in required_parameters
                    ],
                    expected_status_codes=list(dict.fromkeys([*error_codes, 404])),
                ),
            )
        )

    if body_schema is not None:
        required_fields = body_schema.get("required", [])
        if isinstance(required_fields, list) and required_fields:
            missing_field = required_fields[0]
            invalid_body = dict(valid_body) if isinstance(valid_body, Mapping) else None
            if invalid_body is not None:
                invalid_body.pop(missing_field, None)
            scenarios.append(
                QaScenario(
                    category="negative",
                    title="Omit a required request field",
                    rationale=f"Send the request body without required field(s): {missing_field}; check that the API reports a validation error.",
                    review_required=True,
                    request_example=(
                        ScenarioRequestExample(
                            method=method,
                            path=path,
                            json_body=invalid_body,
                            expected_status_codes=error_codes,
                        )
                        if request_is_supported and invalid_body is not None
                        else None
                    ),
                )
            )

        properties = body_schema.get("properties", {})
        if isinstance(properties, Mapping):
            for name, schema in properties.items():
                if not isinstance(name, str) or not isinstance(schema, Mapping):
                    continue
                schema = _resolve_schema(schema, document) or schema
                constraints = ", ".join(f"{key}={schema[key]}" for key in BOUNDARY_KEYS if key in schema)
                if constraints:
                    scenarios.append(
                        QaScenario(
                            category="boundary",
                            title=f"Check boundary values for {name}",
                            rationale=f"Try values around the documented constraint(s) ({constraints}) and verify boundary behavior.",
                            review_required=True,
                            request_example=json_body_example(
                                _body_with_value(valid_body, name, _boundary_value(schema)), success_codes
                            ),
                        )
                    )
                if schema.get("format") or schema.get("pattern"):
                    format_hint = schema.get("format") or f"pattern {schema['pattern']}"
                    scenarios.append(
                        QaScenario(
                            category="invalid_value",
                            title=f"Send invalid {name}",
                            rationale=f"Send a value that violates the documented {format_hint} constraint and check that it is rejected.",
                            review_required=True,
                            request_example=json_body_example(
                                _body_with_value(valid_body, name, _invalid_value(schema)), error_codes
                            ),
                        )
                    )
                if isinstance(schema.get("enum"), list):
                    scenarios.append(
                        QaScenario(
                            category="invalid_value",
                            title=f"Send an undocumented value for {name}",
                            rationale="Send a value outside the documented enum and check that the API rejects it.",
                            review_required=True,
                            request_example=json_body_example(
                                _body_with_value(valid_body, name, "__invalid_enum_value__"), error_codes
                            ),
                        )
                    )

    security = operation.get("security", global_security)
    if isinstance(security, list) and security:
        scenarios.append(
            QaScenario(
                category="security_minded",
                title="Call without authentication",
                rationale="Omit the documented authentication credentials and verify that protected data or actions are not exposed.",
                review_required=True,
            )
        )

    return scenarios[:12]


def _request_body_schema(request_body: Any, document: Mapping[str, Any]) -> Mapping[str, Any] | None:
    resolved = _resolved_request_body(request_body, document)
    content = resolved.get("content") if isinstance(resolved, Mapping) else None
    if not isinstance(content, Mapping):
        return None
    for media_type, media in content.items():
        # The execution adapter sends JSON only; other media types need a matching encoder.
        if "json" in str(media_type).lower() and isinstance(media, Mapping) and isinstance(media.get("schema"), Mapping):
            return _resolve_schema(media["schema"], document)
    return None


def _resolved_request_body(request_body: Any, document: Mapping[str, Any]) -> Mapping[str, Any] | None:
    if not isinstance(request_body, Mapping):
        return None
    return _resolve_schema(request_body, document)


def _request_body_content_type(request_body: Any, document: Mapping[str, Any]) -> str | None:
    resolved = _resolved_request_body(request_body, document)
    content = resolved.get("content") if isinstance(resolved, Mapping) else None
    if not isinstance(content, Mapping):
        return None
    return next((str(media_type) for media_type in content if "json" in str(media_type).lower()), None) or next(
        (str(media_type) for media_type in content if any(kind in str(media_type).lower() for kind in FORM_MEDIA_TYPES)), None
    )


def _request_body_required(request_body: Any, document: Mapping[str, Any]) -> bool:
    resolved = _resolved_request_body(request_body, document)
    return bool(resolved and resolved.get("required"))


def _request_body_fields(request_body: Any, document: Mapping[str, Any]) -> list[ApiBodyField]:
    resolved = _resolved_request_body(request_body, document)
    content = resolved.get("content") if isinstance(resolved, Mapping) else None
    if not isinstance(content, Mapping):
        return []
    media_type = _request_body_content_type(request_body, document)
    media = content.get(media_type) if media_type else None
    schema = _resolve_schema(media.get("schema"), document) if isinstance(media, Mapping) and isinstance(media.get("schema"), Mapping) else None
    properties = schema.get("properties", {}) if isinstance(schema, Mapping) else {}
    required = set(schema.get("required", [])) if isinstance(schema, Mapping) and isinstance(schema.get("required", []), list) else set()
    if not isinstance(properties, Mapping):
        return []
    fields = []
    for name, property_schema in properties.items():
        if not isinstance(name, str) or not isinstance(property_schema, Mapping):
            continue
        property_schema = _resolve_schema(property_schema, document) or property_schema
        fields.append(ApiBodyField(
            name=name,
            required=name in required,
            field_type=str(property_schema.get("type", "string")),
            description=_optional_string(property_schema.get("description")),
            example=_documented_example(property_schema),
            is_file=property_schema.get("format") == "binary" or (
                isinstance(property_schema.get("items"), Mapping)
                and property_schema["items"].get("format") == "binary"
            ),
            multiple=property_schema.get("type") == "array",
        ))
    return fields


def _operation_parameters(path_item: Mapping[str, Any], operation: Mapping[str, Any], global_security: Any, document: Mapping[str, Any]) -> list[ApiParameter]:
    combined: dict[tuple[str, str], ApiParameter] = {}
    for parameters in (path_item.get("parameters", []), operation.get("parameters", [])):
        if not isinstance(parameters, list):
            continue
        for raw_parameter in parameters:
            parameter = _resolve_schema(raw_parameter, document) if isinstance(raw_parameter, Mapping) else None
            if not isinstance(parameter, Mapping):
                continue
            name, location = parameter.get("name"), parameter.get("in")
            if not isinstance(name, str) or location not in {"path", "query", "header", "cookie"}:
                continue
            schema = _resolve_schema(parameter.get("schema"), document) if isinstance(parameter.get("schema"), Mapping) else {}
            example = parameter.get("example")
            if example is None and isinstance(schema, Mapping):
                example = _documented_example(schema)
            key = (name, str(location))
            combined[key] = ApiParameter(
                name=name,
                location=str(location),
                required=location == "path" or parameter.get("required") is True,
                description=_optional_string(parameter.get("description")),
                example=example,
                field_type=str((schema or {}).get("type", "string")) if isinstance(schema, Mapping) else "string",
            )
    security = operation.get("security", global_security)
    security_names = security[0].keys() if isinstance(security, list) and security and isinstance(security[0], Mapping) else []
    schemes = document.get("components", {}).get("securitySchemes", {}) if isinstance(document.get("components"), Mapping) else {}
    if isinstance(schemes, Mapping):
        for scheme_name in security_names:
            scheme = _resolve_schema(schemes.get(scheme_name), document) if isinstance(schemes.get(scheme_name), Mapping) else None
            if not isinstance(scheme, Mapping):
                continue
            if scheme.get("type") == "apiKey" and scheme.get("in") in {"header", "query"} and isinstance(scheme.get("name"), str):
                name, location = scheme["name"], scheme["in"]
            elif scheme.get("type") in {"http", "oauth2", "openIdConnect"}:
                name, location = "Authorization", "header"
            else:
                continue
            key = (name, str(location))
            combined[key] = ApiParameter(
                name=name,
                location=str(location),
                required=True,
                description=_optional_string(scheme.get("description")) or f"Authentication credential ({scheme.get('scheme', scheme.get('type'))}).",
                field_type="string",
            )
    return list(combined.values())


def _documented_example(schema: Mapping[str, Any]) -> Any:
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    enum = schema.get("enum")
    return enum[0] if isinstance(enum, list) and enum else None


def _resolve_schema(
    schema: Mapping[str, Any], document: Mapping[str, Any], seen: frozenset[str] = frozenset()
) -> Mapping[str, Any] | None:
    reference = schema.get("$ref")
    if isinstance(reference, str) and reference.startswith("#/"):
        if reference in seen:
            return {}
        target: Any = document
        for segment in reference[2:].split("/"):
            segment = segment.replace("~1", "/").replace("~0", "~")
            if not isinstance(target, Mapping) or segment not in target:
                return None
            target = target[segment]
        if not isinstance(target, Mapping):
            return None
        resolved = dict(
            _resolve_schema(target, document, seen | {reference}) or {}
        )
        resolved.update({key: value for key, value in schema.items() if key != "$ref"})
        schema = resolved
        seen = seen | {reference}

    def resolve_nested(value: Mapping[str, Any]) -> Mapping[str, Any]:
        # A circular reference resolves to {}; keep it instead of falling back to the raw $ref.
        nested = _resolve_schema(value, document, seen)
        return value if nested is None else nested

    result = dict(schema)
    properties = schema.get("properties")
    if isinstance(properties, Mapping):
        result["properties"] = {
            name: resolve_nested(value) if isinstance(value, Mapping) else value
            for name, value in properties.items()
        }
    items = schema.get("items")
    if isinstance(items, Mapping):
        result["items"] = resolve_nested(items)
    return result


def _status_codes(responses: Any, first_digit: int) -> list[int]:
    if not isinstance(responses, Mapping):
        return []
    return [int(code) for code in responses if isinstance(code, str) and len(code) == 3 and code[0] == str(first_digit) and code.isdigit()]


def _example_from_schema(schema: Mapping[str, Any] | None) -> Any:
    if schema is None:
        return None
    if "example" in schema:
        return schema["example"]
    if "default" in schema:
        return schema["default"]
    enum = schema.get("enum")
    if isinstance(enum, list) and enum:
        return enum[0]

    schema_type = schema.get("type")
    if schema_type == "object" or isinstance(schema.get("properties"), Mapping):
        properties = schema.get("properties", {})
        return {
            name: _example_from_schema(value)
            for name, value in properties.items()
            if isinstance(name, str) and isinstance(value, Mapping)
        }
    if schema_type == "array":
        item = schema.get("items")
        return [_example_from_schema(item)] if isinstance(item, Mapping) else []
    if schema_type == "integer":
        return schema.get("minimum", schema.get("exclusiveMinimum", 1))
    if schema_type == "number":
        return schema.get("minimum", schema.get("exclusiveMinimum", 1.0))
    if schema_type == "boolean":
        return True
    if schema_type == "string":
        if schema.get("format") == "email":
            return "qa@example.com"
        if schema.get("format") == "date":
            return "2026-01-01"
        if schema.get("format") == "date-time":
            return "2026-01-01T12:00:00Z"
        min_length = schema.get("minLength", 1)
        return "x" * min(min_length, 32) if isinstance(min_length, int) else "sample"
    return None


def _body_with_value(body: Mapping[str, Any], name: str, value: Any) -> dict[str, Any]:
    updated = dict(body)
    updated[name] = value
    return updated


def _boundary_value(schema: Mapping[str, Any]) -> Any:
    if "minimum" in schema:
        return schema["minimum"]
    if "maximum" in schema:
        return schema["maximum"]
    if "minLength" in schema and isinstance(schema["minLength"], int):
        return "x" * min(schema["minLength"], 32)
    if "maxLength" in schema and isinstance(schema["maxLength"], int):
        return "x" * min(schema["maxLength"], 32)
    return _example_from_schema(schema)


def _invalid_value(schema: Mapping[str, Any]) -> Any:
    if schema.get("type") in {"integer", "number"}:
        return "not-a-number"
    if schema.get("type") == "boolean":
        return "not-a-boolean"
    return "not-a-valid-value"
