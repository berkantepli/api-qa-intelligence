from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.api.specs import router as specs_router
from app.api.runs import router as runs_router
from app.api.failure_analysis import router as failure_analysis_router
from app.api.ai_scenarios import router as ai_scenarios_router


app = FastAPI(
    title="API QA Intelligence",
    description="Import an OpenAPI contract and inspect its operations for QA planning.",
    version="0.1.0",
)


@app.get("/health", tags=["Health"])
async def health() -> dict[str, str]:
    return {"status": "ok"}


app.include_router(specs_router)
app.include_router(runs_router)
app.include_router(failure_analysis_router)
app.include_router(ai_scenarios_router)


frontend_dist = Path(__file__).resolve().parents[2] / "frontend" / "dist"
if frontend_dist.is_dir():
    app.mount("/", StaticFiles(directory=frontend_dist, html=True), name="frontend")
