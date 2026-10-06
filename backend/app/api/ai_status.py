from fastapi import APIRouter

from app.integrations.ollama import AIStatus, ai_status

router = APIRouter(prefix="/api/v1/ai", tags=["AI"])


@router.get(
    "/status",
    response_model=AIStatus,
    summary="Check the configured AI model",
    description="Asks the configured Ollama server which models it has; no test evidence is sent.",
)
async def get_ai_status() -> AIStatus:
    return await ai_status()
