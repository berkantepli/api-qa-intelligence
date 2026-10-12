from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.domain.request_import import RequestCollection, RequestFileError, parse_request_file

router = APIRouter(prefix="/api/v1/requests", tags=["Request import"])
MAX_REQUEST_FILE_BYTES = 15_000_000


@router.post(
    "/parse",
    response_model=RequestCollection,
    summary="Read the requests in a Postman collection or HAR file",
    description=(
        "Reads each request's method, path, query parameters, and JSON or form body. Headers, auth "
        "settings, and cookies are never read, and credential-like values are left out. Nothing is "
        "stored; the web app compares the requests with the contract and can reuse their values."
    ),
)
async def parse_requests(file: UploadFile = File(...)) -> RequestCollection:
    contents = await file.read(MAX_REQUEST_FILE_BYTES + 1)
    if len(contents) > MAX_REQUEST_FILE_BYTES:
        raise HTTPException(status_code=413, detail="The collection or HAR file must be smaller than 15 MB.")
    try:
        return await run_in_threadpool(parse_request_file, contents)
    except RequestFileError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
