"""Builds the request for a contract check from an operation and the caller's request inputs.

This mirrors frontend/src/requestBuilder.js so a check sends the same request from the web app
and from the CLI. Request inputs use the web app's keys:
``{"parameter:<location>:<name>": "value", "body:<field>": "value", "body:__raw": "<JSON text>"}``.
"""

import json
import re
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import quote

from app.domain.openapi import ApiBodyField, ApiOperation, ApiParameter, QaScenario

SAFE_METHODS = {"GET", "HEAD", "OPTIONS"}
FORM_BODY = re.compile(r"^(multipart/form-data|application/x-www-form-urlencoded)", re.IGNORECASE)
PATH_PARAMETER = re.compile(r"\{([^}]+)\}")


@dataclass
class DescribedOperation:
    operation: ApiOperation
    parameters: list[ApiParameter]
    body_fields: list[ApiBodyField]
    is_form_body: bool
    raw_json_fallback: Any
    valid_body_template: Any
    needs_raw_json_body: bool


@dataclass
class Readiness:
    ready: bool
    missing: list[str] = field(default_factory=list)


def describe_operation(operation: ApiOperation) -> DescribedOperation:
    known = {parameter.name for parameter in operation.parameters if parameter.location == "path"}
    undocumented = [
        ApiParameter(name=name, location="path", required=True)
        for name in PATH_PARAMETER.findall(operation.path)
        if name not in known
    ]
    is_form_body = bool(FORM_BODY.match(operation.request_body_content_type or ""))
    contract = [scenario for scenario in operation.scenarios if scenario.source != "ai_edited"]
    raw_fallback = next(
        (s.request_example.json_body for s in contract if s.request_example and s.request_example.json_body is not None),
        None,
    )
    valid_template = next(
        (
            s.request_example.json_body
            for s in contract
            if s.category == "happy_path" and s.request_example and s.request_example.json_body is not None
        ),
        raw_fallback if raw_fallback is not None else {},
    )
    return DescribedOperation(
        operation=operation,
        parameters=[*operation.parameters, *undocumented],
        body_fields=operation.request_body_fields,
        is_form_body=is_form_body,
        raw_json_fallback=raw_fallback,
        valid_body_template=valid_template,
        needs_raw_json_body=operation.request_body_required and not is_form_body and not operation.request_body_fields,
    )


def _text(value: Any) -> str:
    if value is None:
        return ""
    return json.dumps(value) if isinstance(value, (dict, list)) else str(value)


def parameter_value(parameter: ApiParameter, inputs: dict[str, str]) -> str:
    return inputs.get(f"parameter:{parameter.location}:{parameter.name}", _text(parameter.example))


def body_field_value(body_field: ApiBodyField, inputs: dict[str, str]) -> str:
    return inputs.get(f"body:{body_field.name}", _text(body_field.example))


def raw_body_value(described: DescribedOperation, inputs: dict[str, str]) -> str:
    if "body:__raw" in inputs:
        return inputs["body:__raw"]
    return "" if described.raw_json_fallback is None else json.dumps(described.raw_json_fallback, indent=2)


def _is_json(text: str) -> bool:
    try:
        json.loads(text)
    except ValueError:
        return False
    return True


def request_readiness(described: DescribedOperation, inputs: dict[str, str]) -> Readiness:
    """Whether required details are complete; file fields are never filled by the CLI."""
    body_required = described.operation.request_body_required
    missing_parameters = [p for p in described.parameters if p.required and not parameter_value(p, inputs).strip()]
    missing_fields = [
        f for f in described.body_fields
        if body_required and f.required and (f.is_file or not body_field_value(f, inputs).strip())
    ]
    invalid_json = [
        f for f in described.body_fields
        if not f.is_file and f.field_type in {"object", "array"}
        and body_field_value(f, inputs).strip() and not _is_json(body_field_value(f, inputs))
    ]
    raw = raw_body_value(described, inputs)
    raw_missing = described.needs_raw_json_body and not (raw.strip() and _is_json(raw))
    missing = [
        *(f"{p.name} ({p.location})" for p in missing_parameters),
        *(f"{f.name} (body{' file' if f.is_file else ''})" for f in missing_fields),
        *(f"{f.name} (valid JSON)" for f in invalid_json),
        *(["request body (valid JSON)"] if raw_missing else []),
    ]
    return Readiness(ready=not missing, missing=missing)


def build_check_request(
    described: DescribedOperation, inputs: dict[str, str], scenario: QaScenario, base_url: str, extra_headers: dict[str, str] | None = None
) -> dict[str, Any]:
    """The execute payload for one runnable scenario, as frontend buildCheckRequest builds it."""
    example = scenario.request_example
    if example is None:
        raise ValueError(f"{scenario.title} has no runnable request.")
    operation = described.operation
    overrides: dict[str, str] = getattr(example, "parameter_values", None) or {}
    omitted = {f"{item.get('location')}:{item.get('name')}" for item in example.omitted_parameters}

    def path_value(match: re.Match[str]) -> str:
        name = match.group(1)
        if f"path:{name}" in omitted:
            return ""
        value = overrides.get(f"path:{name}", parameter_value(ApiParameter(name=name, location="path"), inputs))
        return quote(value, safe="-_.!~*'()")

    path = PATH_PARAMETER.sub(path_value, operation.path)
    query = dict(example.query_params)
    headers: dict[str, str] = {}
    cookies: list[str] = []
    for parameter in described.parameters:
        key = f"{parameter.location}:{parameter.name}"
        if key in omitted:
            continue
        override = overrides.get(key)
        value = override if override is not None else parameter_value(parameter, inputs).strip()
        if override is None and not value:
            continue
        if parameter.location == "query":
            query[parameter.name] = value
        elif parameter.location == "header":
            headers[parameter.name] = value
        elif parameter.location == "cookie":
            cookies.append(f"{parameter.name}={quote(value, safe='-_.!~*()')}")
    if cookies:
        headers["Cookie"] = "; ".join(cookies)
    omitted_headers = {key.split(":", 1)[1].lower() for key in omitted if key.startswith("header:")}
    for name, value in (extra_headers or {}).items():
        # A credential the scenario deliberately leaves out stays out (for example the unauthenticated check).
        if name.lower() not in omitted_headers:
            headers[name] = value

    form_fields = dict(example.form_fields)
    if described.needs_raw_json_body:
        json_body: Any = json.loads(raw_body_value(described, inputs))
    elif isinstance(example.json_body, dict):
        json_body = dict(example.json_body)
    else:
        json_body = example.json_body if example.json_body is not None else ({} if described.body_fields else None)
    template = described.valid_body_template if isinstance(described.valid_body_template, dict) else {}
    for body_field in described.body_fields:
        if body_field.is_file:
            continue
        value = body_field_value(body_field, inputs)
        if described.is_form_body:
            form_fields[body_field.name] = value
        elif isinstance(json_body, dict) and body_field.name in json_body:
            scenario_value = example.json_body.get(body_field.name) if isinstance(example.json_body, dict) else None
            # Only fields the scenario left at their valid value take the input; deliberate test values stay.
            if scenario_value == template.get(body_field.name):
                if not value.strip():
                    del json_body[body_field.name]
                else:
                    try:
                        json_body[body_field.name] = json.loads(value)
                    except ValueError:
                        json_body[body_field.name] = value

    return {
        "base_url": base_url,
        "method": example.method,
        "path": path,
        "query_params": query,
        "headers": headers,
        "form_body": example.form_body,
        "form_fields": form_fields,
        "json_body": json_body,
        "expected_status_codes": example.expected_status_codes,
        "response_schemas": operation.response_schemas,
    }
