"""Multi-step checks (flows) that pass values from one response into the next request.

A flow follows a resource through its lifecycle: create it, read it back, update it, delete it,
and confirm it is gone. Flows are suggested from the contract (OpenAPI links first, then matching
a collection's POST with the item path's parameter) and run one step at a time.
"""

import json
import re
from collections.abc import Mapping, Sequence
from typing import TYPE_CHECKING, Any, Literal
from urllib.parse import quote, unquote, urlsplit

from fastapi import HTTPException
from pydantic import AnyHttpUrl, BaseModel, Field, ValidationError, field_validator

from app.domain.evidence import SENSITIVE_KEY
from app.domain.execution import ScenarioExecutionRequest, ScenarioExecutionResult, send_check
from app.domain.network import parse_target_base_url

if TYPE_CHECKING:
    from app.domain.openapi import ApiOperation

VARIABLE_NAME = r"[A-Za-z_][A-Za-z0-9_]{0,63}"
PLACEHOLDER = re.compile(r"\{\{(" + VARIABLE_NAME + r")\}\}")
# A path parameter that still needs a value, such as {userId} (but not a {{variable}}).
UNFILLED_PATH_PARAMETER = re.compile(r"(?<!\{)\{([^{}]+)\}(?!\})")
ID_SUFFIX = re.compile(r"(?:_id|Id|ID)$")
MAX_FLOW_STEPS = 10
GONE_STATUS_CODES = [404, 410]

StepRole = Literal["create", "read", "update", "delete", "verify_deleted", "custom"]
StepStatus = Literal["PASS", "FAIL", "ERROR", "SKIPPED"]


class FlowExtract(BaseModel):
    """Saves a value from a step for later steps, which use it as {{variable}}."""

    variable: str = Field(pattern=f"^{VARIABLE_NAME}$")
    source: Literal["response_body", "request_body"] = "response_body"
    # A JSON Pointer into the body, such as /id or /data/id.
    pointer: str = Field(pattern=r"^(/[^/]*)+$", max_length=200)
    # When the response body has no such value, use the last segment of the Location header
    # (201 Created responses often name the new record there instead of returning it).
    fallback: Literal["location_header"] | None = None


class FlowStep(BaseModel):
    """One request of a flow. {{variable}} placeholders may appear in the path, query and header
    values, and JSON body strings; a body string that is only a placeholder takes the value's type."""

    title: str = Field(min_length=1, max_length=200)
    role: StepRole = "custom"
    method: str
    path: str
    query_params: dict[str, str] = Field(default_factory=dict)
    headers: dict[str, str] = Field(default_factory=dict)
    json_body: Any = None
    expected_status_codes: list[int] = Field(default_factory=lambda: [200], min_length=1, max_length=10)
    response_schemas: dict[str, Any] = Field(default_factory=dict, max_length=40)
    extract: list[FlowExtract] = Field(default_factory=list, max_length=10)
    # Cleanup steps (such as deleting the created record) also run after an earlier step failed.
    always_run: bool = False


class ApiFlow(BaseModel):
    id: str
    title: str
    resource: str
    source: Literal["openapi_link", "inferred"]
    rationale: str
    steps: list[FlowStep]
    # Path parameters the flow cannot fill itself, such as a parent resource's id.
    missing_inputs: list[str] = Field(default_factory=list)
    notes: list[str] = Field(default_factory=list)


class FlowExecutionRequest(BaseModel):
    base_url: AnyHttpUrl
    # Sent with every step (for example credentials); a step's own header of the same name wins.
    headers: dict[str, str] = Field(default_factory=dict)
    max_duration_ms: int | None = Field(default=None, ge=1, le=120_000)
    steps: list[FlowStep] = Field(min_length=1, max_length=MAX_FLOW_STEPS)

    @field_validator("steps")
    @classmethod
    def validate_variables(cls, steps: list[FlowStep]) -> list[FlowStep]:
        defined: set[str] = set()
        for number, step in enumerate(steps, start=1):
            unknown = sorted(_variables_in(step) - defined)
            if unknown:
                names = ", ".join(f"{{{{{name}}}}}" for name in unknown)
                raise ValueError(f"Step {number} uses {names}, which no earlier step saves.")
            unfilled = UNFILLED_PATH_PARAMETER.findall(step.path)
            if unfilled:
                raise ValueError(f"Step {number}: fill in the path parameter(s) {', '.join(unfilled)}.")
            defined |= {rule.variable for rule in step.extract}
        return steps


class FlowStepResult(BaseModel):
    title: str
    role: StepRole
    status: StepStatus
    check: ScenarioExecutionResult | None = None
    # Values saved by this step; sensitive names are redacted.
    saved_values: dict[str, Any] = Field(default_factory=dict)
    reason: str | None = None


class FlowExecutionResult(BaseModel):
    result: Literal["PASS", "FAIL", "ERROR"]
    total: int
    passed: int
    failed: int
    errors: int
    skipped: int
    steps: list[FlowStepResult]


# --- Suggesting flows from the contract -------------------------------------------------------


def infer_flows(operations: Sequence["ApiOperation"]) -> list[ApiFlow]:
    """Suggests a lifecycle flow for each collection whose POST creates records that an item
    path (the collection path plus one {parameter}) reads, updates, or deletes."""
    by_route = {(operation.method, operation.path): operation for operation in operations}
    flows = []
    for create in operations:
        if create.method != "POST" or create.path.endswith("}"):
            continue
        collection = create.path.rstrip("/")
        item_paths = sorted({
            operation.path for operation in operations
            if _item_parameter(collection, operation.path) is not None
        })
        for item_path in item_paths:
            flow = _lifecycle_flow(create, collection, item_path, by_route, operations)
            if flow is not None:
                flows.append(flow)
                break
    parents = [flow for flow in flows if not flow.missing_inputs]
    return [_with_parent(flow, parents) if flow.missing_inputs else flow for flow in flows]


def _shape(path: str) -> str:
    return re.sub(r"\{\{[^{}]+\}\}|\{[^{}]+\}", "{}", path)


def _with_parent(flow: ApiFlow, parents: Sequence[ApiFlow]) -> ApiFlow:
    """A nested collection (/owners/{ownerId}/pets) needs a parent record. When the contract has a
    flow for the parent (/owners), its create step runs first and its delete step cleans up last."""
    if len(flow.missing_inputs) != 1:
        return flow
    name = flow.missing_inputs[0]
    create_path = flow.steps[0].path
    marker = f"{{{name}}}"
    if marker not in create_path:
        return flow
    prefix = create_path[: create_path.index(marker) + len(marker)]
    parent = next((item for item in parents if _shape(prefix) == _shape(item.resource) + "/{}"), None)
    if parent is None or not parent.steps[0].extract:
        return flow
    variable = _variable_name(name)
    if variable in {rule.variable for step in flow.steps for rule in step.extract}:
        return flow
    old = parent.steps[0].extract[0].variable
    parent_create = _renamed(parent.steps[0], old, variable)
    parent_delete = next((_renamed(step, old, variable) for step in parent.steps if step.role == "delete"), None)
    child = [step.model_copy(update={"path": step.path.replace(marker, f"{{{{{variable}}}}}")}) for step in flow.steps]
    steps = [parent_create, *child, *([parent_delete] if parent_delete else [])]
    if len(steps) > MAX_FLOW_STEPS:
        return flow
    parent_resource = _resource_name(parent.resource)
    return flow.model_copy(update={
        "steps": steps,
        "missing_inputs": [],
        "rationale": f"{flow.rationale} It first creates {_article(parent_resource)} {parent_resource} "
                     f"with POST {parent.steps[0].path} for {marker}.",
        "notes": [note for note in flow.notes if not note.startswith("Fill in ")] + parent.notes,
    })


def _renamed(step: FlowStep, old: str, new: str) -> FlowStep:
    def swap(value: Any) -> Any:
        if isinstance(value, str):
            return value.replace(f"{{{{{old}}}}}", f"{{{{{new}}}}}")
        if isinstance(value, list):
            return [swap(item) for item in value]
        if isinstance(value, Mapping):
            return {key: swap(item) for key, item in value.items()}
        return value

    return step.model_copy(update={
        "path": swap(step.path),
        "query_params": swap(step.query_params),
        "json_body": swap(step.json_body),
        "extract": [rule.model_copy(update={"variable": new}) if rule.variable == old else rule for rule in step.extract],
    })


def _item_parameter(collection: str, path: str) -> str | None:
    prefix = collection + "/"
    if not path.startswith(prefix):
        return None
    match = re.fullmatch(r"\{([^{}/]+)\}", path[len(prefix):])
    return match.group(1) if match else None


def _lifecycle_flow(
    create: "ApiOperation",
    collection: str,
    item_path: str,
    by_route: Mapping[tuple[str, str], "ApiOperation"],
    operations: Sequence["ApiOperation"],
) -> ApiFlow | None:
    read = by_route.get(("GET", item_path))
    delete = by_route.get(("DELETE", item_path))
    if read is None and delete is None:
        return None
    create_request = _valid_request(create)
    if create_request is None or create_request.form_body:
        return None

    parameter = _item_parameter(collection, item_path) or ""
    variable = _variable_name(parameter)
    found = _identifier_source(create, parameter, [op for op in (read, delete) if op], operations, create_request.json_body)
    if found is None:
        return None
    extract, source, how = found

    resource = _resource_name(collection)
    item = item_path.replace(f"{{{parameter}}}", f"{{{{{variable}}}}}")
    steps = [_step(f"Create {_article(resource)} {resource}", "create", create, create_request, extract=[extract])]
    notes = []
    read_request = _valid_request(read) if read is not None else None
    if read is not None and read_request is not None:
        steps.append(_step(f"Read the new {resource}", "read", read, read_request, path=item))

    update = _update_step(resource, item_path, item, collection, extract, variable, by_route)
    if update is not None:
        steps.append(update)

    if delete is not None and (delete_request := _valid_request(delete)) is not None:
        steps.append(_step(
            f"Delete the {resource} (cleanup)", "delete", delete, delete_request, path=item, always_run=True
        ))
        if read_request is not None:
            steps.append(FlowStep(
                title=f"Confirm the {resource} is gone",
                role="verify_deleted",
                method="GET",
                path=item,
                query_params=dict(read_request.query_params),
                expected_status_codes=GONE_STATUS_CODES,
            ))
    else:
        notes.append(f"The contract documents no DELETE {item_path}, so the created {resource} is not cleaned up.")
    if len(steps) < 2:
        return None

    missing = sorted({name for step in steps for name in UNFILLED_PATH_PARAMETER.findall(step.path)})
    if missing:
        notes.append(f"Fill in {', '.join(missing)} before running; the flow cannot derive them.")
    return ApiFlow(
        id=f"lifecycle:{create.path}",
        title=f"{resource[:1].upper()}{resource[1:]} lifecycle",
        resource=collection,
        source=source,
        rationale=f"Creates {_article(resource)} {resource} with POST {create.path} and follows it through {item_path} {how}.",
        steps=steps,
        missing_inputs=missing,
        notes=notes,
    )


def _identifier_source(
    create: "ApiOperation",
    parameter: str,
    targets: Sequence["ApiOperation"],
    operations: Sequence["ApiOperation"],
    request_body: Any,
) -> tuple[FlowExtract, Literal["openapi_link", "inferred"], str] | None:
    variable = _variable_name(parameter)
    target_ids = {op.operation_id for op in targets if op.operation_id}
    target_routes = {f"{op.method} {op.path}" for op in targets}
    for link in create.links:
        if link.status[:1] != "2" and link.status not in {"2XX", "DEFAULT"}:
            continue
        if link.operation_id not in target_ids and link.operation not in target_routes:
            continue
        expression = link.parameters.get(parameter, "")
        for prefix, source in (("$response.body#", "response_body"), ("$request.body#", "request_body")):
            if expression.startswith(prefix) and expression[len(prefix):].startswith("/"):
                rule = FlowExtract(variable=variable, source=source, pointer=expression[len(prefix):])
                return rule, "openapi_link", f"using the contract's '{link.name}' link"

    schema = _success_schema(create)
    properties = schema.get("properties") if isinstance(schema, Mapping) else None
    # A response "id" stands for an id-like parameter ({petId}, {order_id}), not for {slug}.
    id_like = bool(ID_SUFFIX.search(parameter)) or parameter.lower() == "id"
    candidates = [parameter, "id"] if id_like else [parameter]
    if isinstance(properties, Mapping):
        for name in dict.fromkeys(candidates):
            if name in properties:
                return (
                    FlowExtract(variable=variable, pointer=f"/{_escape(name)}"),
                    "inferred",
                    f"with the '{name}' field of the create response as {{{parameter}}}",
                )
    if isinstance(request_body, Mapping) and parameter in request_body:
        return (
            FlowExtract(variable=variable, source="request_body", pointer=f"/{_escape(parameter)}"),
            "inferred",
            f"with the '{parameter}' value sent when creating it as {{{parameter}}}",
        )
    if schema is None and id_like:
        # No response schema is documented; most APIs return the new record with an "id".
        return (
            FlowExtract(variable=variable, pointer="/id", fallback="location_header"),
            "inferred",
            f"assuming the create response has an 'id' field, or names the new record in its Location header, for {{{parameter}}} (not documented)",
        )
    return None


def _update_step(
    resource: str,
    item_path: str,
    item: str,
    collection: str,
    extract: FlowExtract,
    variable: str,
    by_route: Mapping[tuple[str, str], "ApiOperation"],
) -> FlowStep | None:
    key = extract.pointer.split("/")[1] if extract.pointer.count("/") == 1 else None
    for method, path in (("PUT", item_path), ("PATCH", item_path), ("PUT", collection), ("PATCH", collection)):
        operation = by_route.get((method, path))
        request = _valid_request(operation) if operation else None
        if operation is None or request is None or request.form_body:
            continue
        body = request.json_body
        names_record = isinstance(body, Mapping) and key is not None and _unescape(key) in body
        # A collection-level update (PUT /pet) can only name the record in its body.
        if path == collection and not names_record:
            continue
        if names_record:
            body = {**body, _unescape(key): f"{{{{{variable}}}}}"}
        return _step(
            f"Update the {resource}", "update", operation, request,
            path=item if path == item_path else path, json_body=body,
        )
    return None


def _valid_request(operation: "ApiOperation") -> Any:
    for scenario in operation.scenarios:
        if scenario.category == "happy_path" and scenario.request_example is not None:
            return scenario.request_example
    return None


def _step(title: str, role: StepRole, operation: "ApiOperation", request: Any, **overrides: Any) -> FlowStep:
    values = {
        "title": title,
        "role": role,
        "method": operation.method,
        "path": operation.path,
        "query_params": dict(request.query_params),
        "json_body": request.json_body,
        "expected_status_codes": list(request.expected_status_codes),
        "response_schemas": dict(operation.response_schemas),
    }
    return FlowStep(**{**values, **overrides})


def _success_schema(operation: "ApiOperation") -> Mapping[str, Any] | None:
    for code in sorted(operation.response_schemas):
        if code.startswith("2"):
            return operation.response_schemas[code]
    return None


def _resource_name(collection: str) -> str:
    segments = [segment for segment in collection.split("/") if segment and not segment.startswith("{")]
    name = segments[-1] if segments else "record"
    # Collections are usually plural (/pets, /categories); steps talk about one record.
    if name.endswith("ies") and len(name) > 4:
        return name[:-3] + "y"
    if name.endswith("s") and not name.endswith(("ss", "us", "is")) and len(name) > 3:
        return name[:-1]
    return name


def _article(word: str) -> str:
    return "an" if word[:1].lower() in "aeiou" else "a"


def _variable_name(parameter: str) -> str:
    name = re.sub(r"[^A-Za-z0-9_]", "_", parameter)[:64] or "id"
    return f"_{name[:63]}" if name[0].isdigit() else name


def _escape(key: str) -> str:
    return key.replace("~", "~0").replace("/", "~1")


def _unescape(key: str) -> str:
    return key.replace("~1", "/").replace("~0", "~")


# --- Running a flow ---------------------------------------------------------------------------


async def execute_flow(payload: FlowExecutionRequest, *, allow_private_network: bool = False) -> FlowExecutionResult:
    """Runs the steps in order. After a step fails, later steps are skipped except cleanup steps
    (always_run), which still run when the values they need were saved."""
    # Refuse a blocked target before sending anything, rather than as one error per step.
    parse_target_base_url(str(payload.base_url), allow_private_network=allow_private_network)
    values: dict[str, Any] = {}
    results: list[FlowStepResult] = []
    stopped = False
    for step in payload.steps:
        missing = sorted(_variables_in(step) - values.keys())
        if stopped and not step.always_run:
            results.append(_skipped(step, "Skipped because an earlier step did not pass."))
            continue
        if missing:
            results.append(_skipped(step, f"Skipped because no earlier step saved {', '.join(missing)}."))
            continue
        try:
            request = _concrete_request(payload, step, values)
        except (ValidationError, HTTPException):
            results.append(FlowStepResult(
                title=step.title, role=step.role, status="ERROR",
                reason="A saved value cannot be used in this request (for example a '..' path segment).",
            ))
            stopped = True
            continue
        check, raw_body = await send_check(request, allow_private_network=allow_private_network)
        check = _scrub(check, values)
        if check.result != "PASS":
            results.append(FlowStepResult(title=step.title, role=step.role, status=check.result, check=check))
            stopped = True
            continue
        saved, problem = _extract(step, request, check, raw_body)
        if problem:
            results.append(FlowStepResult(title=step.title, role=step.role, status="FAIL", check=check, reason=problem))
            stopped = True
            continue
        values.update(saved)
        results.append(FlowStepResult(
            title=step.title, role=step.role, status="PASS", check=check, saved_values=_redacted(saved)
        ))

    counts = {status: sum(result.status == status for result in results) for status in ("PASS", "FAIL", "ERROR", "SKIPPED")}
    return FlowExecutionResult(
        result="FAIL" if counts["FAIL"] else "ERROR" if counts["ERROR"] else "PASS",
        total=len(results),
        passed=counts["PASS"],
        failed=counts["FAIL"],
        errors=counts["ERROR"],
        skipped=counts["SKIPPED"],
        steps=results,
    )


def _skipped(step: FlowStep, reason: str) -> FlowStepResult:
    return FlowStepResult(title=step.title, role=step.role, status="SKIPPED", reason=reason)


def _concrete_request(payload: FlowExecutionRequest, step: FlowStep, values: Mapping[str, Any]) -> ScenarioExecutionRequest:
    def text(value: str, encode: bool = False) -> str:
        return PLACEHOLDER.sub(lambda match: _as_text(values[match.group(1)], encode), value)

    def body(value: Any) -> Any:
        if isinstance(value, str):
            whole = PLACEHOLDER.fullmatch(value)
            return values[whole.group(1)] if whole else text(value)
        if isinstance(value, list):
            return [body(item) for item in value]
        if isinstance(value, Mapping):
            return {key: body(item) for key, item in value.items()}
        return value

    # Validating again keeps the usual safety rules for values that came from a response.
    return ScenarioExecutionRequest.model_validate({
        "base_url": str(payload.base_url),
        "method": step.method,
        "path": text(step.path, encode=True),
        "query_params": {name: text(value) for name, value in step.query_params.items()},
        "headers": {**payload.headers, **{name: text(value) for name, value in step.headers.items()}},
        "json_body": body(step.json_body),
        "expected_status_codes": step.expected_status_codes,
        "response_schemas": step.response_schemas,
        "max_duration_ms": payload.max_duration_ms,
    })


def _extract(
    step: FlowStep, request: ScenarioExecutionRequest, check: ScenarioExecutionResult, raw_body: bytes | None
) -> tuple[dict[str, Any], str | None]:
    saved: dict[str, Any] = {}
    for rule in step.extract:
        value, problem = _value_from_body(rule, request, raw_body)
        if problem and rule.fallback == "location_header":
            location = _location_id(check.response_headers)
            if location:
                value, problem = location, None
            else:
                problem += " The response has no Location header to fall back on either."
        if problem:
            return saved, problem
        saved[rule.variable] = value
    return saved, None


def _value_from_body(rule: FlowExtract, request: ScenarioExecutionRequest, raw_body: bytes | None) -> tuple[Any, str | None]:
    if rule.source == "request_body":
        document, where = request.json_body, "the request body"
    else:
        where = "the response body"
        if raw_body is None:
            return None, f"Could not save {{{{{rule.variable}}}}}: the response body was too large to read."
        try:
            document = json.loads(raw_body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            return None, f"Could not save {{{{{rule.variable}}}}}: {where} is not JSON."
        except RecursionError:
            return None, f"Could not save {{{{{rule.variable}}}}}: {where} is nested too deeply to read."
    value = _resolve_pointer(document, rule.pointer)
    if value is None or isinstance(value, (Mapping, list)):
        found = "has no value" if value is None else "is not a single value"
        return None, f"Could not save {{{{{rule.variable}}}}}: {rule.pointer} in {where} {found}."
    return value, None


def _location_id(headers: Mapping[str, str]) -> str | None:
    """The last path segment of a Location header: "/pets/42" or "https://api/pets/42" gives "42"."""
    location = next((value for name, value in headers.items() if name.lower() == "location"), "")
    segment = urlsplit(location).path.rstrip("/").rpartition("/")[2]
    return unquote(segment) or None


def _resolve_pointer(document: Any, pointer: str) -> Any:
    for raw in pointer.split("/")[1:]:
        key = _unescape(raw)
        if isinstance(document, Mapping):
            document = document.get(key)
        elif isinstance(document, list) and key.isdigit() and int(key) < len(document):
            document = document[int(key)]
        else:
            return None
    return document


def _variables_in(step: FlowStep) -> set[str]:
    texts = [step.path, *step.query_params.values(), *step.headers.values(), json.dumps(step.json_body)]
    return {name for value in texts for name in PLACEHOLDER.findall(value)}


def _as_text(value: Any, encode: bool) -> str:
    raw = value if isinstance(value, str) else json.dumps(value)
    return quote(raw, safe="") if encode else raw


def _scrub(check: ScenarioExecutionResult, values: Mapping[str, Any]) -> ScenarioExecutionResult:
    """Evidence redaction goes by field names; a saved token sent under another name (for example
    an X-Session header or a path segment) is hidden here by its value."""
    secrets = [_as_text(value, False) for name, value in values.items() if SENSITIVE_KEY.search(name)]
    secrets = [secret for secret in secrets if len(secret) >= 4]
    if not secrets:
        return check

    def hide(text: str) -> str:
        for secret in secrets:
            text = text.replace(secret, "[REDACTED]").replace(quote(secret, safe=""), "[REDACTED]")
        return text

    return check.model_copy(update={
        "request_url": hide(check.request_url),
        "request_headers": {name: hide(value) for name, value in check.request_headers.items()},
        "request_body": hide(check.request_body),
        "response_headers": {name: hide(value) for name, value in check.response_headers.items()},
        "response_body": hide(check.response_body),
    })


def _redacted(saved: Mapping[str, Any]) -> dict[str, Any]:
    return {name: "[REDACTED]" if SENSITIVE_KEY.search(name) else value for name, value in saved.items()}
