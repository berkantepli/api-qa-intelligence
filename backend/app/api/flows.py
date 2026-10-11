from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.domain.flows import (
    ApiFlow,
    FlowExecutionRequest,
    FlowExecutionResult,
    execute_flow,
    infer_flows,
)
from app.domain.openapi import ApiOperation

router = APIRouter(prefix="/api/v1/flows", tags=["Flows"])


class FlowSuggestionRequest(BaseModel):
    operations: list[ApiOperation] = Field(max_length=2_000)


class FlowSuggestionResponse(BaseModel):
    flows: list[ApiFlow]


@router.post("/suggest", response_model=FlowSuggestionResponse)
async def suggest_flows(payload: FlowSuggestionRequest) -> FlowSuggestionResponse:
    """Suggests flows for an API overview saved before flows were part of the import."""
    return FlowSuggestionResponse(flows=infer_flows(payload.operations))


@router.post("/execute", response_model=FlowExecutionResult)
async def run_flow(payload: FlowExecutionRequest) -> FlowExecutionResult:
    return await execute_flow(payload)
