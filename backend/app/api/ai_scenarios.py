from fastapi import APIRouter, HTTPException, status
from pydantic import BaseModel

from app.domain.openapi import ApiOperation, QaScenario
from app.integrations.ollama import AIProviderUnavailable, propose_scenarios

router = APIRouter(prefix="/api/v1/specs", tags=["QA planning"])


class ScenarioIdeasRequest(BaseModel):
    operation: ApiOperation


class ScenarioIdeasResponse(BaseModel):
    scenarios: list[QaScenario]


@router.post(
    "/scenario-ideas",
    response_model=ScenarioIdeasResponse,
    summary="Suggest additional QA scenarios",
    description="Sends the selected operation contract to the configured Ollama model. No target API request is made.",
)
async def generate_scenario_ideas(payload: ScenarioIdeasRequest) -> ScenarioIdeasResponse:
    operation = payload.operation
    context = {
        "method": operation.method[:10],
        "path": operation.path[:500],
        "operation_id": (operation.operation_id or "")[:200],
        "summary": (operation.summary or "")[:500],
        "tags": [tag[:100] for tag in operation.tags[:20]],
        "parameters": [
            {
                "name": parameter.name[:100],
                "location": parameter.location[:30],
                "required": parameter.required,
                "description": (parameter.description or "")[:300],
                "type": parameter.field_type[:50],
            }
            for parameter in operation.parameters[:50]
        ],
        "request_body": {
            "content_type": (operation.request_body_content_type or "")[:100],
            "required": operation.request_body_required,
            "fields": [
                {
                    "name": field.name[:100],
                    "required": field.required,
                    "type": field.field_type[:50],
                    "description": (field.description or "")[:300],
                }
                for field in operation.request_body_fields[:50]
            ],
        },
        # Checks that already exist; a refresh replaces previous review-only ideas, so those are not listed.
        "existing_checks": [
            {"title": scenario.title[:200], "category": scenario.category[:40]}
            for scenario in operation.scenarios[:40]
            if scenario.source != "ai"
        ],
        "has_inputs_to_vary": bool(operation.parameters or operation.request_body_fields or operation.request_body_content_type),
    }
    try:
        ideas = await propose_scenarios(context)
    except AIProviderUnavailable as error:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The configured AI model is unavailable. Check the Ollama service and selected model.",
        ) from error

    return ScenarioIdeasResponse(scenarios=[
        QaScenario(
            category=idea.category,
            title=idea.title,
            rationale=idea.rationale,
            review_required=True,
            source="ai",
            request_example=None,
        )
        for idea in ideas.scenarios
    ])
