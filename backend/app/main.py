import os
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles
from starlette.middleware.trustedhost import TrustedHostMiddleware

from app.api.ai_scenarios import router as ai_scenarios_router
from app.api.ai_status import router as ai_status_router
from app.api.failure_analysis import router as failure_analysis_router
from app.api.runs import router as runs_router
from app.api.sample_values import router as sample_values_router
from app.api.specs import router as specs_router
from app.api.targets import router as targets_router
from app.api.workspace import router as workspace_router
from app.version import APP_VERSION

app = FastAPI(
    title="API QA Intelligence",
    description="Import an OpenAPI contract and inspect its operations for QA planning.",
    version=APP_VERSION,
)

# The app runs on the user's machine without a login. Answering only to its own host names stops
# DNS rebinding: a web page whose domain is re-pointed to 127.0.0.1 cannot read or delete the
# workspace or send checks through this backend. Add names (or "*") with API_QA_ALLOWED_HOSTS.
ALLOWED_HOSTS = ["localhost", "127.0.0.1", *(
    host.strip() for host in os.getenv("API_QA_ALLOWED_HOSTS", "").split(",") if host.strip()
)]
app.add_middleware(TrustedHostMiddleware, allowed_hosts=ALLOWED_HOSTS)


@app.get("/health", tags=["Health"])
async def health() -> dict[str, str]:
    return {"status": "ok", "version": APP_VERSION}


app.include_router(specs_router)
app.include_router(runs_router)
app.include_router(failure_analysis_router)
app.include_router(ai_scenarios_router)
app.include_router(ai_status_router)
app.include_router(targets_router)
app.include_router(sample_values_router)
app.include_router(workspace_router)


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
