"""Signs in to the target API once so its token can be used by every check."""

import json
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.domain.execution import ScenarioExecutionRequest, send_check
from app.domain.flows import resolve_json_pointer

router = APIRouter(prefix="/api/v1/auth", tags=["Scenario execution"])

# Where sign-in responses usually put the token, tried in order when no pointer is given.
COMMON_TOKEN_POINTERS = (
    "/access_token",
    "/accessToken",
    "/token",
    "/id_token",
    "/jwt",
    "/data/access_token",
    "/data/accessToken",
    "/data/token",
    "/auth/token",
)


class SignInRequest(ScenarioExecutionRequest):
    method: str = "POST"
    expected_status_codes: list[int] = Field(default_factory=lambda: [200, 201], min_length=1, max_length=10)
    # A JSON Pointer such as /access_token; empty means "look in the usual places".
    token_pointer: str | None = Field(default=None, pattern=r"^(/[^/]*)+$", max_length=200)


class SignInResult(BaseModel):
    signed_in: bool
    status_code: int | None = None
    duration_ms: int
    # The token is returned to the open tab only; it is never saved or logged.
    token: str | None = None
    token_pointer: str | None = None
    error: str | None = None


@router.post("/sign-in", response_model=SignInResult)
async def sign_in(payload: SignInRequest) -> SignInResult:
    check, raw_body = await send_check(payload)
    failed = SignInResult(signed_in=False, status_code=check.response_status, duration_ms=check.duration_ms)
    if check.result == "ERROR":
        return failed.model_copy(update={"error": check.error})
    if check.response_status not in payload.expected_status_codes:
        return failed.model_copy(update={"error": f"The sign-in request returned HTTP {check.response_status}; check the URL, path, and credentials."})
    if raw_body is None:
        return failed.model_copy(update={"error": "The sign-in response was too large to read."})
    try:
        document: Any = json.loads(raw_body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError):
        return failed.model_copy(update={"error": "The sign-in response is not JSON, so no token could be read from it."})

    pointers = [payload.token_pointer] if payload.token_pointer else COMMON_TOKEN_POINTERS
    for pointer in pointers:
        value = resolve_json_pointer(document, pointer)
        if isinstance(value, (str, int)) and not isinstance(value, bool) and str(value):
            return SignInResult(
                signed_in=True,
                status_code=check.response_status,
                duration_ms=check.duration_ms,
                token=str(value),
                token_pointer=pointer,
            )
    where = f"at {payload.token_pointer}" if payload.token_pointer else f"in the usual places ({', '.join(COMMON_TOKEN_POINTERS[:4])}, …)"
    return failed.model_copy(update={"error": f"The sign-in succeeded, but the response has no token {where}. Enter where it is, for example /data/jwt."})
