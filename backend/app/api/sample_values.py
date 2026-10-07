from typing import Any, Literal

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.domain.samples import (
    SampleField,
    blocked_reason,
    complete_values_schema,
    matches_schema,
    schema_sample,
)
from app.integrations.ollama import AIProviderUnavailable, propose_sample_values

router = APIRouter(prefix="/api/v1/specs", tags=["QA planning"])


class SampleOperation(BaseModel):
    method: str = Field(max_length=10)
    path: str = Field(max_length=500)
    summary: str | None = Field(default=None, max_length=500)


class SampleValuesRequest(BaseModel):
    operation: SampleOperation
    fields: list[SampleField] = Field(max_length=60)


class UnfilledField(BaseModel):
    key: str
    reason: str


class SampleValuesResponse(BaseModel):
    source: Literal["ai", "schema"]
    values: dict[str, Any] = Field(default_factory=dict)
    unfilled: list[UnfilledField] = Field(default_factory=list)


@router.post(
    "/sample-values",
    response_model=SampleValuesResponse,
    summary="Suggest sample values for empty request inputs",
    description=(
        "Asks the configured Ollama model for schema-valid sample values. Only field names, locations, "
        "descriptions, and schemas are sent; no entered values, credentials, or target URL. Path parameters, "
        "headers, cookies, files, and credentials are never generated. Falls back to schema-based samples "
        "when the model is unavailable. No target API request is made."
    ),
)
async def suggest_sample_values(payload: SampleValuesRequest) -> SampleValuesResponse:
    unfilled = [UnfilledField(key=field.key, reason=reason) for field in payload.fields if (reason := blocked_reason(field))]
    eligible = [field for field in payload.fields if blocked_reason(field) is None]
    if not eligible:
        return SampleValuesResponse(source="ai", unfilled=unfilled)

    values_schema = {
        "type": "object",
        "properties": {field.key: complete_values_schema(field.value_schema or {"type": "string"}) for field in eligible},
        "required": [field.key for field in eligible],
    }
    context = {
        "operation": payload.operation.model_dump(),
        "fields": [
            {"key": field.key, "name": field.name, "location": field.location, "required": field.required, "description": field.description}
            for field in eligible
        ],
    }
    try:
        proposed = await propose_sample_values(context, values_schema)
    except AIProviderUnavailable:
        return SampleValuesResponse(
            source="schema",
            values={field.key: schema_sample(field) for field in eligible},
            unfilled=unfilled,
        )

    values = {}
    for field in eligible:
        value = proposed.get(field.key)
        if matches_schema(value, field.value_schema):
            values[field.key] = value
        else:
            unfilled.append(UnfilledField(key=field.key, reason="The AI could not produce a valid value; enter it yourself."))
    return SampleValuesResponse(source="ai", values=values, unfilled=unfilled)
