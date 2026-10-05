from typing import Literal

from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel, Field

from app.domain.evidence import redact_headers, redact_text, sanitize_url
from app.integrations.ollama import AIProviderUnavailable, FailureAnalysis, analyze_failure

router = APIRouter(prefix="/api/v1/runs", tags=["QA analysis"])


class FailureAnalysisRequest(BaseModel):
    result: Literal["FAIL"]
    scenario_title: str = Field(default="", max_length=200)
    method: str = Field(max_length=10)
    path: str = Field(max_length=2_000)
    expected_status_codes: list[int] = Field(default_factory=list, max_length=10)
    response_status: int | None = None
    duration_ms: int | None = None
    request_url: str = Field(default="", max_length=4_000)
    request_headers: dict[str, str] = Field(default_factory=dict, max_length=50)
    request_body: str = Field(default="", max_length=10_000)
    response_headers: dict[str, str] = Field(default_factory=dict, max_length=50)
    response_body: str = Field(default="", max_length=10_000)
    response_truncated: bool = False
    error: str | None = Field(default=None, max_length=1_000)


@router.post(
    "/analyze-failure",
    response_model=FailureAnalysis,
    summary="Analyze a failed check",
    description="Sends redacted run evidence to the configured Ollama model; the target API is not called.",
)
async def analyze_failed_check(payload: FailureAnalysisRequest) -> FailureAnalysis:
    evidence = {
        "result": payload.result,
        "scenario_title": payload.scenario_title,
        "method": payload.method.upper(),
        "path": payload.path,
        "expected_status_codes": payload.expected_status_codes,
        "actual_status_code": payload.response_status,
        "duration_ms": payload.duration_ms,
        "request_url": sanitize_url(payload.request_url) if payload.request_url else "",
        "request_headers": redact_headers(payload.request_headers),
        "request_body": redact_text(payload.request_body),
        "response_headers": redact_headers(payload.response_headers),
        "response_body": redact_text(payload.response_body),
        "response_truncated": payload.response_truncated,
        "error": redact_text(payload.error) if payload.error else None,
    }
    try:
        analysis = await analyze_failure(evidence)
    except AIProviderUnavailable as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The configured local AI model is unavailable. Check Ollama and OLLAMA_MODEL.",
        ) from error
    return analysis
