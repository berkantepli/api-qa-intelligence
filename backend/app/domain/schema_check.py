"""Checks a JSON response against the response schema the OpenAPI contract documents.

Only the structural rules that contracts state reliably are enforced: type (including
OpenAPI 3.0 ``nullable`` and 3.1 type lists), enum/const, required properties, properties,
additionalProperties: false, items, numeric and length bounds, and allOf/anyOf/oneOf.
``format`` and ``pattern`` are not enforced, because their meaning varies between tools.
"""

import json
from collections.abc import Mapping
from typing import Any, Literal

from pydantic import BaseModel, Field

MAX_DEPTH = 8
MAX_PROPERTIES = 60
MAX_ERRORS = 10
JSON_TYPES = {"object", "array", "string", "number", "integer", "boolean", "null"}


class SchemaCheck(BaseModel):
    status: Literal["passed", "failed", "not_documented", "skipped"]
    detail: str = ""
    errors: list[str] = Field(default_factory=list)


def response_schemas(responses: Any, document: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    """Resolved JSON schemas keyed by response code ("200", "4XX", "default")."""
    if not isinstance(responses, Mapping):
        return {}
    schemas: dict[str, dict[str, Any]] = {}
    for code, response in responses.items():
        response = _follow_ref(response, document) if isinstance(response, Mapping) else None
        content = response.get("content") if isinstance(response, Mapping) else None
        if not isinstance(content, Mapping):
            continue
        for media_type, media in content.items():
            if "json" in str(media_type).lower() and isinstance(media, Mapping) and isinstance(media.get("schema"), Mapping):
                schemas[str(code).upper()] = _resolve(media["schema"], document, frozenset(), 0)
                break
    return schemas


def schema_for_status(schemas: Mapping[str, Any], status: int) -> dict[str, Any] | None:
    for key in (str(status), f"{str(status)[0]}XX", "DEFAULT"):
        if isinstance(schemas.get(key), Mapping):
            return schemas[key]
    return None


def check_response(schemas: Mapping[str, Any] | None, status: int, content_type: str, body: bytes, truncated: bool) -> SchemaCheck:
    if not schemas:
        return SchemaCheck(status="not_documented", detail="The contract documents no JSON response schemas for this endpoint.")
    schema = schema_for_status(schemas, status)
    if schema is None:
        return SchemaCheck(status="not_documented", detail=f"The contract documents no JSON schema for HTTP {status}.")
    if truncated:
        return SchemaCheck(status="skipped", detail="The response was too large to check completely.")
    if not body.strip():
        return SchemaCheck(status="failed", detail="The response body is empty.", errors=["$: the contract documents a JSON body, but the response is empty"])
    if "json" not in content_type.lower():
        return SchemaCheck(status="failed", detail="The response is not JSON.", errors=[f"$: expected a JSON response, received {content_type or 'no content type'}"])
    try:
        value = json.loads(body)
    except ValueError:
        return SchemaCheck(status="failed", detail="The response is not valid JSON.", errors=["$: the response body is not valid JSON"])
    errors = validate(value, schema)
    if errors:
        more = len(errors) >= MAX_ERRORS
        return SchemaCheck(
            status="failed",
            detail=f"{len(errors)}{'+' if more else ''} difference{'s' if len(errors) != 1 else ''} from the documented schema.",
            errors=errors,
        )
    return SchemaCheck(status="passed", detail="The response matches the documented schema.")


def validate(value: Any, schema: Mapping[str, Any], path: str = "$") -> list[str]:
    errors: list[str] = []
    _validate(value, schema, path, errors)
    return errors[:MAX_ERRORS]


def _validate(value: Any, schema: Mapping[str, Any], path: str, errors: list[str]) -> None:
    if len(errors) >= MAX_ERRORS or not isinstance(schema, Mapping):
        return

    if value is None and schema.get("nullable") is True:
        return
    for part in schema.get("allOf", []) if isinstance(schema.get("allOf"), list) else []:
        _validate(value, part, path, errors)
    for keyword in ("anyOf", "oneOf"):
        options = schema.get(keyword)
        # oneOf is checked like anyOf: requiring exactly one match misreports overlapping options.
        if isinstance(options, list) and options and not any(not validate(value, option, path) for option in options):
            errors.append(f"{path}: does not match any of the documented alternatives")
            return

    types = _types(schema)
    if types and not any(_is_type(value, kind) for kind in types):
        errors.append(f"{path}: expected {' or '.join(sorted(types))}, received {_describe(value)}")
        return
    if "const" in schema and value != schema["const"]:
        errors.append(f"{path}: expected {schema['const']!r}")
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        allowed = ", ".join(repr(item) for item in schema["enum"][:8])
        errors.append(f"{path}: {value!r} is not one of {allowed}")

    if isinstance(value, bool):
        return
    if isinstance(value, (int, float)):
        if isinstance(schema.get("minimum"), (int, float)) and value < schema["minimum"]:
            errors.append(f"{path}: {value} is below the minimum {schema['minimum']}")
        if isinstance(schema.get("maximum"), (int, float)) and value > schema["maximum"]:
            errors.append(f"{path}: {value} is above the maximum {schema['maximum']}")
    elif isinstance(value, str):
        if isinstance(schema.get("minLength"), int) and len(value) < schema["minLength"]:
            errors.append(f"{path}: shorter than {schema['minLength']} characters")
        if isinstance(schema.get("maxLength"), int) and len(value) > schema["maxLength"]:
            errors.append(f"{path}: longer than {schema['maxLength']} characters")
    elif isinstance(value, list):
        if isinstance(schema.get("minItems"), int) and len(value) < schema["minItems"]:
            errors.append(f"{path}: fewer than {schema['minItems']} items")
        if isinstance(schema.get("maxItems"), int) and len(value) > schema["maxItems"]:
            errors.append(f"{path}: more than {schema['maxItems']} items")
        if isinstance(schema.get("items"), Mapping):
            for index, item in enumerate(value):
                _validate(item, schema["items"], f"{path}[{index}]", errors)
    elif isinstance(value, dict):
        properties = schema.get("properties") if isinstance(schema.get("properties"), Mapping) else {}
        for name in schema.get("required", []) if isinstance(schema.get("required"), list) else []:
            if name not in value:
                errors.append(f"{path}.{name}: required property is missing")
        for name, item in value.items():
            if name in properties:
                _validate(item, properties[name], f"{path}.{name}", errors)
            elif schema.get("additionalProperties") is False:
                errors.append(f"{path}.{name}: property is not documented")
            elif isinstance(schema.get("additionalProperties"), Mapping):
                _validate(item, schema["additionalProperties"], f"{path}.{name}", errors)


def _types(schema: Mapping[str, Any]) -> set[str]:
    declared = schema.get("type")
    types = {declared} if isinstance(declared, str) else set(declared) if isinstance(declared, list) else set()
    types &= JSON_TYPES
    if types and schema.get("nullable") is True:
        types.add("null")
    return types


def _is_type(value: Any, kind: str) -> bool:
    return {
        "null": value is None,
        "boolean": isinstance(value, bool),
        "integer": isinstance(value, int) and not isinstance(value, bool) or isinstance(value, float) and value.is_integer(),
        "number": isinstance(value, (int, float)) and not isinstance(value, bool),
        "string": isinstance(value, str),
        "array": isinstance(value, list),
        "object": isinstance(value, dict),
    }[kind]


def _describe(value: Any) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    if isinstance(value, str):
        return "string"
    return "array" if isinstance(value, list) else "object"


def _follow_ref(node: Mapping[str, Any], document: Mapping[str, Any], seen: frozenset[str] = frozenset()) -> Mapping[str, Any] | None:
    reference = node.get("$ref")
    if not isinstance(reference, str):
        return node
    if not reference.startswith("#/") or reference in seen:
        return None
    target: Any = document
    for segment in reference[2:].split("/"):
        segment = segment.replace("~1", "/").replace("~0", "~")
        if not isinstance(target, Mapping) or segment not in target:
            return None
        target = target[segment]
    return _follow_ref(target, document, seen | {reference}) if isinstance(target, Mapping) else None


def _resolve(schema: Mapping[str, Any], document: Mapping[str, Any], seen: frozenset[str], depth: int) -> dict[str, Any]:
    """Inlines $refs a few levels deep; cycles and deeper levels accept any value."""
    if depth > MAX_DEPTH:
        return {}
    reference = schema.get("$ref")
    if isinstance(reference, str):
        if reference in seen:
            return {}
        target = _follow_ref({"$ref": reference}, document)
        if target is None:
            return {}
        merged = {**target, **{key: value for key, value in schema.items() if key != "$ref"}}
        return _resolve(merged, document, seen | {reference}, depth)

    def nested(value: Any) -> Any:
        return _resolve(value, document, seen, depth + 1) if isinstance(value, Mapping) else {}

    resolved: dict[str, Any] = {
        key: schema[key]
        for key in ("type", "nullable", "enum", "const", "required", "minimum", "maximum", "minLength", "maxLength", "minItems", "maxItems")
        if key in schema
    }
    if isinstance(schema.get("properties"), Mapping):
        resolved["properties"] = {
            str(name): nested(value) for name, value in list(schema["properties"].items())[:MAX_PROPERTIES]
        }
    if "items" in schema:
        resolved["items"] = nested(schema["items"])
    # Beyond the property cap, undocumented-looking properties may be documented ones, so skip that rule.
    if schema.get("additionalProperties") is False and len(schema.get("properties") or {}) <= MAX_PROPERTIES:
        resolved["additionalProperties"] = False
    elif isinstance(schema.get("additionalProperties"), Mapping):
        resolved["additionalProperties"] = nested(schema["additionalProperties"])
    for keyword in ("allOf", "anyOf", "oneOf"):
        if isinstance(schema.get(keyword), list):
            resolved[keyword] = [nested(item) for item in schema[keyword][:10]]
    return resolved
