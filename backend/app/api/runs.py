from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.domain.execution import (
    MAX_RESPONSE_SIZE_BYTES,
    ScenarioExecutionRequest,
    ScenarioExecutionResult,
)
from app.domain.execution import (
    execute_scenario as run_check,
)

__all__ = ["MAX_RESPONSE_SIZE_BYTES", "router"]

router = APIRouter(prefix="/api/v1/runs", tags=["Scenario execution"])


class ScenarioBatchRequest(BaseModel):
    scenarios: list[ScenarioExecutionRequest] = Field(min_length=1, max_length=20)


class ScenarioBatchResult(BaseModel):
    total: int
    passed: int
    failed: int
    errors: int
    results: list[ScenarioExecutionResult]


@router.post("/execute", response_model=ScenarioExecutionResult)
async def execute_scenario(payload: ScenarioExecutionRequest) -> ScenarioExecutionResult:
    return await run_check(payload)


@router.post("/execute-batch", response_model=ScenarioBatchResult)
async def execute_scenario_batch(payload: ScenarioBatchRequest) -> ScenarioBatchResult:
    results = [await run_check(scenario) for scenario in payload.scenarios]
    return ScenarioBatchResult(
        total=len(results),
        passed=sum(result.result == "PASS" for result in results),
        failed=sum(result.result == "FAIL" for result in results),
        errors=sum(result.result == "ERROR" for result in results),
        results=results,
    )
