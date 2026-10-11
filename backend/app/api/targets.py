import asyncio
import time
from typing import Literal

import httpx
from fastapi import APIRouter
from pydantic import AnyHttpUrl, BaseModel

from app.domain.evidence import sanitize_url
from app.domain.network import (
    HostResolutionError,
    parse_target_base_url,
    request_error_reason,
    target_client,
)

router = APIRouter(prefix="/api/v1/targets", tags=["Scenario execution"])
CHECK_TIMEOUT_SECONDS = 8
# Servers that reject HEAD are asked again with GET, which is also read-only.
HEAD_NOT_SUPPORTED = {405, 501}


class TargetCheckRequest(BaseModel):
    base_url: AnyHttpUrl


class TargetCheckResult(BaseModel):
    url: str
    reachable: bool
    method: Literal["HEAD", "GET"] | None = None
    status_code: int | None = None
    duration_ms: int
    error: str | None = None
    # No answer within the probe's time limit: the API may be down, or just slower than the probe waits.
    timed_out: bool = False


@router.post(
    "/check",
    response_model=TargetCheckResult,
    summary="Check that a target API responds",
    description=(
        "Sends a read-only HEAD request (GET if HEAD is not supported) to the base URL, using the same "
        "safety rules as check execution. Redirects are not followed and no response body is read."
    ),
)
async def check_target(payload: TargetCheckRequest) -> TargetCheckResult:
    started = time.perf_counter()
    try:
        base = parse_target_base_url(str(payload.base_url))
    except HostResolutionError:
        # An unknown host is a reachability problem, not a blocked target.
        return TargetCheckResult(
            url=sanitize_url(str(payload.base_url)), reachable=False, duration_ms=0,
            error="The host name could not be resolved. Check the spelling of the target URL.",
        )
    url = sanitize_url(str(base))
    method: Literal["HEAD", "GET"] = "HEAD"
    timed_out = False
    try:
        async with asyncio.timeout(CHECK_TIMEOUT_SECONDS), target_client(
            timeout=httpx.Timeout(CHECK_TIMEOUT_SECONDS, connect=5), follow_redirects=False
        ) as client:
            response = await client.head(base)
            if response.status_code in HEAD_NOT_SUPPORTED:
                method = "GET"
                async with client.stream("GET", base) as streamed:
                    response = streamed
    except (TimeoutError, httpx.TimeoutException):
        timed_out = True
        error = f"The target API did not respond within {CHECK_TIMEOUT_SECONDS} seconds."
    except httpx.RequestError as request_error:
        error = request_error_reason(request_error, "the target API", CHECK_TIMEOUT_SECONDS)
    else:
        return TargetCheckResult(
            url=url,
            reachable=True,
            method=method,
            status_code=response.status_code,
            duration_ms=round((time.perf_counter() - started) * 1000),
        )
    return TargetCheckResult(
        url=url,
        reachable=False,
        method=method,
        duration_ms=round((time.perf_counter() - started) * 1000),
        error=error,
        timed_out=timed_out,
    )
