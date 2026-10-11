import asyncio
import json

import httpx
import yaml
from fastapi import APIRouter, File, HTTPException, UploadFile, status
from fastapi.concurrency import run_in_threadpool
from pydantic import BaseModel

from app.domain.contract_diff import ContractDiff, diff_contracts
from app.domain.documents import UNEXPECTED_SHAPE, DocumentTooComplexError, parse_document
from app.domain.network import ensure_safe_target_host, request_error_reason, target_client
from app.domain.openapi import ApiOverview, OpenApiDocumentError, SpecUrlRequest, summarize_openapi

router = APIRouter(prefix="/api/v1/specs", tags=["API specifications"])
MAX_SPEC_SIZE_BYTES = 2_000_000
SPEC_FETCH_TIMEOUT_SECONDS = 10


@router.post("/import", response_model=ApiOverview)
async def import_specification(file: UploadFile = File(...)) -> ApiOverview:
    contents = await file.read(MAX_SPEC_SIZE_BYTES + 1)
    if len(contents) > MAX_SPEC_SIZE_BYTES:
        raise HTTPException(
            status_code=413,
            detail="The specification must be smaller than 2 MB.",
        )

    return await run_in_threadpool(_parse_specification, contents, file.filename or "")


@router.post("/import-url", response_model=ApiOverview)
async def import_specification_from_url(payload: SpecUrlRequest) -> ApiOverview:
    url = httpx.URL(str(payload.url))
    if url.username or url.password:
        raise HTTPException(
            status_code=422,
            detail="OpenAPI URLs with embedded credentials are not supported.",
        )

    ensure_safe_target_host(url, label="OpenAPI URL")

    try:
        # The read timeout applies per chunk; the overall deadline also stops a server that trickles bytes.
        async with asyncio.timeout(SPEC_FETCH_TIMEOUT_SECONDS), target_client(
            timeout=httpx.Timeout(SPEC_FETCH_TIMEOUT_SECONDS, connect=4), follow_redirects=False
        ) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                contents = bytearray()
                async for chunk in response.aiter_bytes():
                    contents.extend(chunk)
                    if len(contents) > MAX_SPEC_SIZE_BYTES:
                        raise HTTPException(
                            status_code=413,
                            detail="The specification must be smaller than 2 MB.",
                        )
    except HTTPException:
        raise
    except TimeoutError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=f"The OpenAPI URL did not finish sending the document within {SPEC_FETCH_TIMEOUT_SECONDS} seconds.",
        ) from error
    except httpx.HTTPStatusError as error:
        raise HTTPException(status_code=status.HTTP_502_BAD_GATEWAY, detail=_status_problem(error.response)) from error
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail=request_error_reason(error, "the OpenAPI URL", SPEC_FETCH_TIMEOUT_SECONDS),
        ) from error

    return await run_in_threadpool(_parse_specification, bytes(contents), url.path)


def _status_problem(response: httpx.Response) -> str:
    if response.is_redirect and response.headers.get("location"):
        return f"The OpenAPI URL redirects to {response.headers['location']}. Use that address instead."
    if response.status_code == 404:
        return "The OpenAPI URL returned 404 Not Found. Check the address of the JSON or YAML file."
    if response.status_code in {401, 403}:
        return f"The OpenAPI URL returned HTTP {response.status_code}; it needs authentication. Download the file and upload it instead."
    return f"The OpenAPI URL returned HTTP {response.status_code}. Check the URL and try again."


def _parse_specification(contents: bytes, filename: str) -> ApiOverview:
    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The specification must be a UTF-8 JSON or YAML file.",
        ) from error

    if text.lstrip()[:1] == "<":
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="This is an HTML or XML page, not an OpenAPI document. Use the address of the raw JSON or YAML file.",
        )
    try:
        document = parse_document(text, as_json=filename.lower().endswith(".json"))
    except DocumentTooComplexError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (json.JSONDecodeError, yaml.YAMLError) as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The file could not be read as valid JSON or YAML.",
        ) from error

    try:
        return summarize_openapi(document)
    except OpenApiDocumentError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
    except (AttributeError, TypeError, KeyError, IndexError, ValueError, RecursionError) as error:
        raise HTTPException(status_code=422, detail=UNEXPECTED_SHAPE) from error



class ContractDiffRequest(BaseModel):
    base: ApiOverview
    head: ApiOverview


# A plain def runs in the thread pool, so comparing two large contracts does not block other requests.
@router.post("/diff", response_model=ContractDiff)
def compare_specifications(payload: ContractDiffRequest) -> ContractDiff:
    """Compares two API overviews (the earlier version as base) and classifies every change."""
    return diff_contracts(payload.base, payload.head)
