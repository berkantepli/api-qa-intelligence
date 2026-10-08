"""Runs one QA check against a target API and records redacted evidence."""

import base64
import binascii
import json
import time
from typing import Any, Literal
from urllib.parse import unquote, urlencode

import httpx
from fastapi import HTTPException
from pydantic import AnyHttpUrl, BaseModel, Field, field_validator

from app.domain.evidence import redact_headers, redact_text, redact_value, sanitize_url
from app.domain.network import parse_target_base_url
from app.domain.schema_check import SchemaCheck, check_response

MAX_RESPONSE_SIZE_BYTES = 250_000
MAX_DISPLAY_BODY_CHARS = 10_000
MAX_UPLOAD_SIZE_BYTES = 10_000_000
BLOCKED_HEADERS = {"host", "content-length", "transfer-encoding"}


class ScenarioFileUpload(BaseModel):
    filename: str = Field(min_length=1, max_length=255)
    content_type: str = Field(default="application/octet-stream", max_length=150)
    content_base64: str = Field(max_length=14_000_000)


class ScenarioExecutionRequest(BaseModel):
    base_url: AnyHttpUrl
    method: str
    path: str
    query_params: dict[str, str] = Field(default_factory=dict)
    form_body: bool = False
    headers: dict[str, str] = Field(default_factory=dict)
    form_fields: dict[str, str] = Field(default_factory=dict)
    file_uploads: dict[str, list[ScenarioFileUpload]] = Field(default_factory=dict)
    json_body: Any = None
    expected_status_codes: list[int] = Field(default_factory=lambda: [200], min_length=1, max_length=10)
    # The operation's documented JSON response schemas; when given, the response body is checked too.
    response_schemas: dict[str, Any] = Field(default_factory=dict, max_length=40)

    @field_validator("method")
    @classmethod
    def normalize_method(cls, value: str) -> str:
        method = value.upper()
        if method not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}:
            raise ValueError("Use a supported HTTP method.")
        return method

    @field_validator("path")
    @classmethod
    def validate_path(cls, value: str) -> str:
        if not value.startswith("/") or value.startswith("//") or "?" in value or "#" in value:
            raise ValueError("Path must be an absolute API path such as /users/123.")
        if any(segment == ".." for segment in unquote(value).split("/")):
            raise ValueError("Path cannot contain parent-directory segments.")
        return value

    @field_validator("expected_status_codes")
    @classmethod
    def validate_status_codes(cls, values: list[int]) -> list[int]:
        if any(code < 100 or code > 599 for code in values):
            raise ValueError("Expected status codes must be between 100 and 599.")
        return values

    @field_validator("headers")
    @classmethod
    def validate_headers(cls, values: dict[str, str]) -> dict[str, str]:
        blocked = [name for name in values if name.lower() in BLOCKED_HEADERS]
        if blocked:
            raise ValueError(f"These headers cannot be overridden: {', '.join(blocked)}.")
        return values

    @property
    def sends_form(self) -> bool:
        return self.form_body or bool(self.form_fields) or any(self.file_uploads.values())


class ScenarioExecutionResult(BaseModel):
    result: Literal["PASS", "FAIL", "ERROR"]
    method: str
    path: str
    response_status: int | None = None
    expected_status_codes: list[int]
    duration_ms: int
    response_body: str = ""
    response_truncated: bool = False
    request_url: str = ""
    request_headers: dict[str, str] = Field(default_factory=dict)
    request_body: str = ""
    response_headers: dict[str, str] = Field(default_factory=dict)
    schema_check: SchemaCheck | None = None
    error: str | None = None


async def execute_scenario(
    payload: ScenarioExecutionRequest, *, allow_private_network: bool = False
) -> ScenarioExecutionResult:
    """Sends one check's request and judges the response; shared by the web API and the CLI."""
    base = parse_target_base_url(str(payload.base_url), allow_private_network=allow_private_network)

    # OpenAPI servers often carry a base path (e.g. /api/v3); operation paths are relative to it.
    target = base.copy_with(path=base.path.rstrip("/") + payload.path, query=None)
    query = urlencode(payload.query_params)
    request_url = sanitize_url(f"{target}?{query}" if query else str(target))
    request_headers = _request_headers(payload)
    request_body_evidence = _request_evidence(payload)
    files = []
    for field_name, uploads in payload.file_uploads.items():
        for upload in uploads:
            try:
                content = base64.b64decode(upload.content_base64, validate=True)
            except (binascii.Error, ValueError) as error:
                raise HTTPException(status_code=422, detail=f"The uploaded file for '{field_name}' is invalid.") from error
            if len(content) > MAX_UPLOAD_SIZE_BYTES:
                raise HTTPException(status_code=413, detail="Each uploaded file must be 10 MB or smaller.")
            files.append((field_name, (upload.filename, content, upload.content_type)))

    request_options: dict[str, Any] = {"params": payload.query_params, "headers": payload.headers}
    if payload.sends_form:
        # Let HTTPX generate the multipart boundary instead of reusing a caller-supplied Content-Type.
        request_options["headers"] = {
            name: value for name, value in payload.headers.items() if name.lower() != "content-type"
        }
        request_options["data"] = payload.form_fields or None
        request_options["files"] = files or None
    else:
        request_options["json"] = payload.json_body

    started = time.perf_counter()
    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15, connect=5), follow_redirects=False) as client:
            async with client.stream(payload.method, target, **request_options) as response:
                response_content = bytearray()
                truncated = False
                async for chunk in response.aiter_bytes():
                    remaining = MAX_RESPONSE_SIZE_BYTES - len(response_content)
                    response_content.extend(chunk[:remaining])
                    if len(chunk) > remaining:
                        truncated = True
                        break
                duration_ms = round((time.perf_counter() - started) * 1000)
                content_type = response.headers.get("content-type", "")
                body = _display_response_body(bytes(response_content), content_type)
                status_matches = response.status_code in payload.expected_status_codes
                # The body is only checked when the status is the expected one; a wrong status already fails.
                schema_check = (
                    check_response(payload.response_schemas, response.status_code, content_type, bytes(response_content), truncated)
                    if status_matches and payload.response_schemas and payload.method != "HEAD"
                    else None
                )
                return ScenarioExecutionResult(
                    result="PASS" if status_matches and (schema_check is None or schema_check.status != "failed") else "FAIL",
                    method=payload.method,
                    path=payload.path,
                    response_status=response.status_code,
                    expected_status_codes=payload.expected_status_codes,
                    duration_ms=duration_ms,
                    response_body=redact_text(body)[:MAX_DISPLAY_BODY_CHARS],
                    response_truncated=truncated or len(body) > MAX_DISPLAY_BODY_CHARS,
                    request_url=request_url,
                    request_headers=request_headers,
                    request_body=request_body_evidence,
                    response_headers=redact_headers(dict(response.headers)),
                    schema_check=schema_check,
                )
    except httpx.TimeoutException:
        error = "The API did not respond before the 15 second timeout."
    except httpx.RequestError:
        error = "The request could not reach the target API."
    return ScenarioExecutionResult(
        result="ERROR",
        method=payload.method,
        path=payload.path,
        expected_status_codes=payload.expected_status_codes,
        duration_ms=round((time.perf_counter() - started) * 1000),
        request_url=request_url,
        request_headers=request_headers,
        request_body=request_body_evidence,
        error=error,
    )


def _request_headers(payload: ScenarioExecutionRequest) -> dict[str, str]:
    headers = dict(payload.headers)
    if payload.sends_form:
        headers.setdefault("Content-Type", "multipart/form-data (boundary generated by client)")
    elif payload.json_body is not None:
        headers.setdefault("Content-Type", "application/json")
    return redact_headers(headers)


def _request_evidence(payload: ScenarioExecutionRequest) -> str:
    evidence: dict[str, Any] = {}
    if payload.sends_form:
        evidence["form_fields"] = payload.form_fields
        evidence["files"] = {
            name: [{"filename": item.filename, "content_type": item.content_type} for item in uploads]
            for name, uploads in payload.file_uploads.items()
        }
    elif payload.json_body is not None:
        evidence["json"] = payload.json_body
    if not evidence:
        return ""
    return json.dumps(redact_value(evidence), ensure_ascii=False, indent=2)


def _display_response_body(contents: bytes, content_type: str) -> str:
    text = contents.decode("utf-8", errors="replace")
    if "json" in content_type.lower():
        try:
            return json.dumps(json.loads(text), ensure_ascii=False, indent=2)
        except json.JSONDecodeError:
            pass
    return text
