import time
from typing import Literal

import httpx
from fastapi import APIRouter
from pydantic import AnyHttpUrl, BaseModel

from app.domain.evidence import sanitize_url
from app.domain.network import parse_target_base_url

router = APIRouter(prefix="/api/v1/targets", tags=["Scenario execution"])
CHECK_TIMEOUT_SECONDS = 5
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
    base = parse_target_base_url(str(payload.base_url))
    url = sanitize_url(str(base))
    started = time.perf_counter()
    method: Literal["HEAD", "GET"] = "HEAD"
    try:
        async with httpx.AsyncClient(
            timeout=httpx.Timeout(CHECK_TIMEOUT_SECONDS, connect=3), follow_redirects=False
        ) as client:
            response = await client.head(base)
            if response.status_code in HEAD_NOT_SUPPORTED:
                method = "GET"
                async with client.stream("GET", base) as streamed:
                    response = streamed
    except httpx.TimeoutException:
        error = f"No response within {CHECK_TIMEOUT_SECONDS} seconds."
    except httpx.ConnectError:
        error = "The connection was refused or the host is unreachable."
    except httpx.RequestError:
        error = "The request could not reach the target API."
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
    )
