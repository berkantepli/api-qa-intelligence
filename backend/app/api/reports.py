from fastapi import APIRouter
from fastapi.responses import HTMLResponse

from app.domain.html_report import HtmlReportRequest, render_html_report
from app.domain.run_compare import CompareRequest, RunComparison, compare_runs
from app.version import APP_VERSION

router = APIRouter(prefix="/api/v1", tags=["Reports"])


@router.post("/runs/compare", response_model=RunComparison)
def compare(payload: CompareRequest) -> RunComparison:
    """What changed between two moments: each check's latest result before and after."""
    return compare_runs(payload.before, payload.after)


@router.post("/reports/html", response_class=HTMLResponse)
def html_report(payload: HtmlReportRequest) -> HTMLResponse:
    """A self-contained HTML report of a run or of an API's coverage."""
    return HTMLResponse(render_html_report(payload, APP_VERSION))
