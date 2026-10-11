from fastapi import APIRouter, File, HTTPException, UploadFile
from fastapi.concurrency import run_in_threadpool

from app.domain.results_import import ImportedResults, ResultsFileError, parse_results_file

router = APIRouter(prefix="/api/v1/results", tags=["Test results"])
MAX_RESULTS_SIZE_BYTES = 5_000_000


@router.post(
    "/parse",
    response_model=ImportedResults,
    summary="Read test results from another tool",
    description=(
        "Reads a Newman JSON report or JUnit XML into a list of test cases with their method, path, "
        "response status, and outcome when the report records them. Nothing is stored; the web app "
        "matches the cases to endpoints and adds them to Run history."
    ),
)
async def parse_results(file: UploadFile = File(...)) -> ImportedResults:
    contents = await file.read(MAX_RESULTS_SIZE_BYTES + 1)
    if len(contents) > MAX_RESULTS_SIZE_BYTES:
        raise HTTPException(status_code=413, detail="The test results file must be smaller than 5 MB.")
    try:
        return await run_in_threadpool(parse_results_file, contents)
    except ResultsFileError as error:
        raise HTTPException(status_code=422, detail=str(error)) from error
