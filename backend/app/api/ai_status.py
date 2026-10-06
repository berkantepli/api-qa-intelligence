from fastapi import APIRouter

from app.integrations.ollama import AIDiagnosis, AIStatus, ai_status, diagnose_ai

router = APIRouter(prefix="/api/v1/ai", tags=["AI"])


@router.get(
    "/status",
    response_model=AIStatus,
    summary="Check the configured AI model",
    description="Asks the configured Ollama server which models it has; no test evidence is sent.",
)
async def get_ai_status() -> AIStatus:
    return await ai_status()


@router.get(
    "/diagnose",
    response_model=AIDiagnosis,
    summary="Diagnose the AI analysis setup",
    description=(
        "Checks the backend, the Ollama server, the configured model, and a short test prompt, in order. "
        "Later steps are skipped when an earlier one fails. No test evidence is sent."
    ),
)
async def get_ai_diagnosis() -> AIDiagnosis:
    return await diagnose_ai()
