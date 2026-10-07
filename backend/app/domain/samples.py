"""Rules and checks for filling request inputs with sample values on request."""

import re
import uuid
from datetime import date, datetime
from typing import Any, Literal

from pydantic import BaseModel, Field

from app.domain.evidence import SENSITIVE_KEY
from app.domain.openapi import example_from_schema


class SampleField(BaseModel):
    key: str = Field(max_length=200)
    name: str = Field(max_length=200)
    location: Literal["path", "query", "header", "cookie", "body"]
    required: bool = False
    description: str | None = Field(default=None, max_length=500)
    value_schema: dict[str, Any] | None = None
    is_file: bool = False
    credential: bool = False


def blocked_reason(field: SampleField) -> str | None:
    """Why a field must be filled by the user instead of generated, or None when it can be generated."""
    if field.credential or SENSITIVE_KEY.search(field.name):
        return "Credentials are never generated; enter your own test credential."
    if field.location == "path":
        return "Needs a real ID or value from your test environment."
    if field.location in {"header", "cookie"}:
        return "Headers and cookies often carry credentials or session data; enter it yourself."
    if field.is_file or (field.value_schema or {}).get("format") == "binary":
        return "Choose a file to upload."
    return None


def complete_values_schema(schema: dict[str, Any]) -> dict[str, Any]:
    """Asks the model for whole values: every object property is required and arrays have an item.

    Only the request sent to the model changes; answers are still validated against the contract schema.
    """
    completed = dict(schema)
    if isinstance(schema.get("properties"), dict):
        completed["properties"] = {name: complete_values_schema(value) for name, value in schema["properties"].items() if isinstance(value, dict)}
        completed["required"] = list(completed["properties"])
    if isinstance(schema.get("items"), dict):
        completed["items"] = complete_values_schema(schema["items"])
        completed.setdefault("minItems", 1)
    return completed


def schema_sample(field: SampleField) -> Any:
    return example_from_schema(field.value_schema or {"type": "string"})


def _matches_format(value: str, value_format: str | None) -> bool:
    try:
        if value_format == "date":
            date.fromisoformat(value)
        elif value_format == "date-time":
            datetime.fromisoformat(value.replace("Z", "+00:00"))
        elif value_format == "uuid":
            uuid.UUID(value)
        elif value_format == "email":
            return re.fullmatch(r"[^@\s]+@[^@\s]+\.[^@\s]+", value) is not None
    except ValueError:
        return False
    return True


def matches_schema(value: Any, schema: dict[str, Any] | None) -> bool:
    """A small JSON Schema subset check for generated values: type, enum, ranges, lengths, formats."""
    if value is None:
        return False
    if not schema:
        return True
    if isinstance(schema.get("enum"), list) and value not in schema["enum"]:
        return False
    schema_type = schema.get("type")
    if schema_type == "string" or (schema_type is None and isinstance(value, str)):
        if not isinstance(value, str):
            return False
        if len(value) < schema.get("minLength", 0) or len(value) > schema.get("maxLength", len(value)):
            return False
        pattern = schema.get("pattern")
        if isinstance(pattern, str):
            try:
                if re.search(pattern, value) is None:
                    return False
            except re.error:
                pass
        return _matches_format(value, schema.get("format"))
    if schema_type in {"integer", "number"}:
        allowed = int if schema_type == "integer" else (int, float)
        if isinstance(value, bool) or not isinstance(value, allowed):
            return False
        return schema.get("minimum", value) <= value <= schema.get("maximum", value)
    if schema_type == "boolean":
        return isinstance(value, bool)
    if schema_type == "array":
        if not isinstance(value, list):
            return False
        if len(value) < schema.get("minItems", 0) or len(value) > schema.get("maxItems", len(value)):
            return False
        return all(matches_schema(item, schema.get("items")) for item in value)
    if schema_type == "object" or isinstance(schema.get("properties"), dict):
        if not isinstance(value, dict):
            return False
        if any(name not in value for name in schema.get("required", []) if isinstance(name, str)):
            return False
        properties = schema.get("properties", {})
        return all(matches_schema(item, properties[name]) for name, item in value.items() if name in properties)
    return True
