"""The /api/v1 contract that 1.x promises to keep.

Within 1.x, routes and response or request fields may be added, but none listed here may be
removed or renamed. A failure here means a breaking change: keep the old route or field, or
plan it for 2.0 (see docs/API.md)."""

from app.main import app

STABLE_ROUTES = {
    ("DELETE", "/api/v1/workspace"),
    ("DELETE", "/api/v1/workspace/apis/{api_id}"),
    ("DELETE", "/api/v1/workspace/runs/{run_id}"),
    ("GET", "/api/v1/ai/diagnose"),
    ("GET", "/api/v1/ai/status"),
    ("GET", "/api/v1/workspace"),
    ("GET", "/health"),
    ("POST", "/api/v1/runs/analyze-failure"),
    ("POST", "/api/v1/runs/execute"),
    ("POST", "/api/v1/runs/execute-batch"),
    ("POST", "/api/v1/specs/import"),
    ("POST", "/api/v1/specs/import-url"),
    ("POST", "/api/v1/specs/sample-values"),
    ("POST", "/api/v1/specs/scenario-ideas"),
    ("POST", "/api/v1/targets/check"),
    ("PUT", "/api/v1/workspace/apis/{api_id}"),
    ("PUT", "/api/v1/workspace/inputs/{api_id}"),
    ("PUT", "/api/v1/workspace/runs/{run_id}"),
}

STABLE_FIELDS = {
    "AIDiagnosis": {"application", "available", "base_url", "inference", "model", "model_check", "ollama", "provider"},
    "AIStatus": {"available_models", "base_url", "model", "model_available", "provider", "reachable"},
    "ApiBodyField": {"description", "example", "field_type", "is_file", "multiple", "name", "required", "value_schema"},
    "ApiOperation": {"method", "operation_id", "parameters", "path", "request_body_content_type", "request_body_fields", "request_body_required", "response_schemas", "scenarios", "summary", "tags"},
    "ApiOverview": {"openapi_version", "operation_count", "operations", "servers", "title", "version"},
    "ApiParameter": {"credential", "description", "example", "field_type", "location", "name", "required", "value_schema"},
    "DiagnosisStep": {"reason", "status", "suggested_action"},
    "FailureAnalysis": {"likely_causes", "limitations", "next_steps", "summary"},
    "FailureAnalysisRequest": {"duration_ms", "error", "expected_status_codes", "max_duration_ms", "method", "path", "request_body", "request_headers", "request_url", "response_body", "response_headers", "response_status", "response_truncated", "result", "scenario_title", "schema_errors"},
    "PossibleCause": {"cause", "confidence", "evidence"},
    "QaScenario": {"category", "rationale", "request_example", "review_required", "source", "title"},
    "SampleField": {"credential", "description", "is_file", "key", "location", "name", "required", "value_schema"},
    "SampleOperation": {"method", "path", "summary"},
    "SampleValuesRequest": {"fields", "operation"},
    "SampleValuesResponse": {"source", "unfilled", "values"},
    "ScenarioBatchRequest": {"scenarios"},
    "ScenarioBatchResult": {"errors", "failed", "passed", "results", "total"},
    "ScenarioExecutionRequest": {"base_url", "expected_status_codes", "file_uploads", "form_body", "form_fields", "headers", "json_body", "max_duration_ms", "method", "path", "query_params", "response_schemas"},
    "ScenarioExecutionResult": {"duration_ms", "error", "expected_status_codes", "max_duration_ms", "method", "path", "request_body", "request_headers", "request_url", "response_body", "response_headers", "response_status", "response_truncated", "result", "schema_check", "too_slow"},
    "ScenarioFileUpload": {"content_base64", "content_type", "filename"},
    "ScenarioIdeasRequest": {"operation"},
    "ScenarioIdeasResponse": {"scenarios"},
    "ScenarioRequestExample": {"expected_status_codes", "form_body", "form_fields", "json_body", "method", "omitted_parameters", "path", "query_params"},
    "SchemaCheck": {"detail", "errors", "status"},
    "SpecUrlRequest": {"url"},
    "TargetCheckRequest": {"base_url"},
    "TargetCheckResult": {"duration_ms", "error", "method", "reachable", "status_code", "url"},
    "UnfilledField": {"key", "reason"},
}


def test_no_stable_route_is_removed():
    paths = app.openapi()["paths"]
    current = {(method.upper(), path) for path, operations in paths.items() for method in operations}
    assert STABLE_ROUTES - current == set()


def test_no_stable_field_is_removed():
    schemas = app.openapi()["components"]["schemas"]
    missing = {
        name: sorted(fields - set(schemas.get(name, {}).get("properties", {})))
        for name, fields in STABLE_FIELDS.items()
        if fields - set(schemas.get(name, {}).get("properties", {}))
    }
    assert missing == {}
