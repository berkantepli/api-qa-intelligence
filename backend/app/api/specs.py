import json
import httpx
import yaml
from fastapi import APIRouter, File, HTTPException, UploadFile, status

from app.domain.openapi import ApiOverview, OpenApiDocumentError, SpecUrlRequest, summarize_openapi
from app.domain.network import ensure_safe_target_host


router = APIRouter(prefix="/api/v1/specs", tags=["API specifications"])
MAX_SPEC_SIZE_BYTES = 2_000_000


@router.post("/import", response_model=ApiOverview)
async def import_specification(file: UploadFile = File(...)) -> ApiOverview:
    contents = await file.read(MAX_SPEC_SIZE_BYTES + 1)
    if len(contents) > MAX_SPEC_SIZE_BYTES:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail="The specification must be smaller than 2 MB.",
        )

    return _parse_specification(contents, file.filename or "")


@router.post("/import-url", response_model=ApiOverview)
async def import_specification_from_url(payload: SpecUrlRequest) -> ApiOverview:
    url = httpx.URL(str(payload.url))
    if url.username or url.password:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="OpenAPI URLs with embedded credentials are not supported.",
        )

    ensure_safe_target_host(url.host, url.port or (443 if url.scheme == "https" else 80))

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(10, connect=4), follow_redirects=False) as client:
            async with client.stream("GET", url) as response:
                response.raise_for_status()
                contents = bytearray()
                async for chunk in response.aiter_bytes():
                    contents.extend(chunk)
                    if len(contents) > MAX_SPEC_SIZE_BYTES:
                        raise HTTPException(
                            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                            detail="The specification must be smaller than 2 MB.",
                        )
    except HTTPException:
        raise
    except httpx.HTTPError as error:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="The OpenAPI document could not be fetched. Check the URL and try again.",
        ) from error

    return _parse_specification(bytes(contents), url.path)


def _parse_specification(contents: bytes, filename: str) -> ApiOverview:
    try:
        text = contents.decode("utf-8-sig")
    except UnicodeDecodeError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The specification must be a UTF-8 JSON or YAML file.",
        ) from error

    try:
        document = json.loads(text) if filename.lower().endswith(".json") else yaml.safe_load(text)
    except (json.JSONDecodeError, yaml.YAMLError) as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="The file could not be read as valid JSON or YAML.",
        ) from error

    try:
        return summarize_openapi(document)
    except OpenApiDocumentError as error:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)) from error

