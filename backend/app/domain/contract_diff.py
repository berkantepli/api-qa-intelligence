"""Compares two versions of an API contract from a client's point of view.

Every change is classified as breaking (an existing client can stop working), warning (worth a
look: a client may not handle it), or safe. Requests and responses are judged in opposite
directions: a tighter rule on a request field breaks clients that send old values, while the same
rule on a response field only promises less. Endpoints with breaking or warning changes list the
checks worth running again.
"""

from collections.abc import Mapping
from typing import TYPE_CHECKING, Any, Literal

from pydantic import BaseModel, Field, computed_field

if TYPE_CHECKING:
    from app.domain.openapi import ApiOperation, ApiOverview

Severity = Literal["breaking", "warning", "safe"]
Direction = Literal["request", "response"]
SEVERITY_ORDER = {"breaking": 0, "warning": 1, "safe": 2}
LOWER_BOUNDS = ("minimum", "exclusiveMinimum", "minLength", "minItems")
UPPER_BOUNDS = ("maximum", "exclusiveMaximum", "maxLength", "maxItems")
MAX_SCHEMA_DEPTH = 6


class ContractChange(BaseModel):
    severity: Severity
    # Where the change is, such as "parameter petId (path)", "request body name", "response 200 $.tags[]".
    location: str
    message: str


class EndpointDiff(BaseModel):
    method: str
    path: str
    status: Literal["added", "removed", "changed"]
    # The previous path when only the name of a path parameter changed.
    previous_path: str | None = None
    changes: list[ContractChange] = Field(default_factory=list)
    # Titles of the endpoint's current checks that the changes affect.
    retest: list[str] = Field(default_factory=list)

    @computed_field
    @property
    def severity(self) -> Severity:
        return min((change.severity for change in self.changes), key=SEVERITY_ORDER.__getitem__, default="safe")

    @property
    def key(self) -> str:
        return f"{self.method} {self.path}"


class ContractDiff(BaseModel):
    base_title: str
    base_version: str
    head_title: str
    head_version: str
    endpoints: list[EndpointDiff] = Field(default_factory=list)

    @computed_field
    @property
    def totals(self) -> dict[str, int]:
        changes = [change.severity for endpoint in self.endpoints for change in endpoint.changes]
        return {
            "endpoints": len(self.endpoints),
            "breaking": changes.count("breaking"),
            "warning": changes.count("warning"),
            "safe": changes.count("safe"),
            "retest": sum(bool(endpoint.retest) for endpoint in self.endpoints),
        }

    @computed_field
    @property
    def markdown(self) -> str:
        """The report as Markdown, for a pull request comment or an issue."""
        return diff_markdown(self)

    @property
    def severity(self) -> Severity | None:
        if not self.endpoints:
            return None
        return min((endpoint.severity for endpoint in self.endpoints), key=SEVERITY_ORDER.__getitem__)


def diff_contracts(base: "ApiOverview", head: "ApiOverview") -> ContractDiff:
    before = {f"{operation.method} {operation.path}": operation for operation in base.operations}
    after = {f"{operation.method} {operation.path}": operation for operation in head.operations}
    removed = [key for key in before if key not in after]
    added = [key for key in after if key not in before]

    # /pets/{id} → /pets/{petId} calls the same URL: compare it as one endpoint.
    renamed: dict[str, str] = {}
    for old_key in list(removed):
        match = next((key for key in added if _route_shape(key) == _route_shape(old_key)), None)
        if match:
            renamed[match] = old_key
            removed.remove(old_key)
            added.remove(match)

    endpoints: list[EndpointDiff] = []
    for key, operation in after.items():
        if key in added:
            endpoints.append(EndpointDiff(
                method=operation.method, path=operation.path, status="added",
                changes=[ContractChange(severity="safe", location="endpoint", message="New endpoint.")],
            ))
            continue
        old_key = renamed.get(key, key)
        changes = operation_changes(before[old_key], operation)
        if old_key != key:
            changes.insert(0, ContractChange(
                severity="safe", location="path",
                message=f"Path parameter renamed: {before[old_key].path} is now {operation.path}; the URL is the same.",
            ))
        if changes:
            endpoint = EndpointDiff(
                method=operation.method, path=operation.path, status="changed",
                previous_path=before[old_key].path if old_key != key else None, changes=changes,
            )
            endpoint.retest = _retest(operation, endpoint.changes) if endpoint.severity != "safe" else []
            endpoints.append(endpoint)
    for key in removed:
        operation = before[key]
        endpoints.append(EndpointDiff(
            method=operation.method, path=operation.path, status="removed",
            changes=[ContractChange(severity="breaking", location="endpoint", message="Endpoint removed; clients that call it will fail.")],
        ))

    endpoints.sort(key=lambda item: (SEVERITY_ORDER[item.severity], item.path, item.method))
    return ContractDiff(
        base_title=base.title, base_version=base.version, head_title=head.title, head_version=head.version,
        endpoints=endpoints,
    )


def _route_shape(key: str) -> str:
    method, _, path = key.partition(" ")
    parts = ["{}" if part.startswith("{") and part.endswith("}") else part for part in path.split("/")]
    return f"{method} {'/'.join(parts)}"


# --- One endpoint ------------------------------------------------------------------------------


def operation_changes(before: "ApiOperation", after: "ApiOperation") -> list[ContractChange]:
    changes: list[ContractChange] = []
    changes += _parameter_changes(before, after)
    changes += _request_body_changes(before, after)
    changes += _response_changes(before, after)
    return changes


def _parameter_changes(before: "ApiOperation", after: "ApiOperation") -> list[ContractChange]:
    changes = []
    old = {(item.name, item.location): item for item in before.parameters}
    new = {(item.name, item.location): item for item in after.parameters}
    old_auth = any(item.credential for item in before.parameters)
    new_auth = any(item.credential for item in after.parameters)
    if new_auth and not old_auth:
        changes.append(ContractChange(severity="breaking", location="authentication", message="Now requires authentication; clients without credentials will be rejected."))
    if old_auth and not new_auth:
        changes.append(ContractChange(severity="warning", location="authentication", message="No longer documents authentication; check that the endpoint is not exposed by mistake."))

    for key, parameter in new.items():
        location = f"parameter {parameter.name} ({parameter.location})"
        if parameter.credential:
            continue
        previous = old.get(key)
        # A path parameter keeps its position when renamed; that is reported on the path.
        if previous is None and parameter.location == "path":
            continue
        if previous is None:
            changes.append(ContractChange(
                severity="breaking" if parameter.required else "safe", location=location,
                message="New required parameter; clients that do not send it will be rejected." if parameter.required else "New optional parameter.",
            ))
            continue
        if parameter.required and not previous.required:
            changes.append(ContractChange(severity="breaking", location=location, message="Now required; clients that leave it out will be rejected."))
        elif previous.required and not parameter.required:
            changes.append(ContractChange(severity="safe", location=location, message="Now optional."))
        changes += schema_changes(_parameter_schema(previous), _parameter_schema(parameter), location, "request")
    for key, parameter in old.items():
        if key not in new and not parameter.credential and parameter.location != "path":
            changes.append(ContractChange(
                severity="warning", location=f"parameter {parameter.name} ({parameter.location})",
                message="Parameter removed; clients that still send it may be ignored or rejected.",
            ))
    return changes


def _parameter_schema(parameter: Any) -> dict[str, Any]:
    schema = dict(parameter.value_schema or {})
    schema.setdefault("type", parameter.field_type)
    return schema


def _request_body_changes(before: "ApiOperation", after: "ApiOperation") -> list[ContractChange]:
    old_type, new_type = before.request_body_content_type, after.request_body_content_type
    if old_type is None and new_type is None:
        return []
    if old_type is None:
        return [ContractChange(
            severity="breaking" if after.request_body_required else "safe", location="request body",
            message=f"New {'required ' if after.request_body_required else 'optional '}request body ({new_type}).",
        )]
    if new_type is None:
        return [ContractChange(severity="warning", location="request body", message="Request body removed; clients that still send one may be rejected.")]
    changes = []
    if old_type != new_type:
        changes.append(ContractChange(severity="breaking", location="request body", message=f"Content type changed from {old_type} to {new_type}."))
    if after.request_body_required and not before.request_body_required:
        changes.append(ContractChange(severity="breaking", location="request body", message="Request body is now required."))
    changes += schema_changes(_body_schema(before), _body_schema(after), "request body", "request")
    return changes


def _body_schema(operation: "ApiOperation") -> dict[str, Any]:
    return {
        "type": "object",
        "properties": {
            field.name: {**(field.value_schema or {}), "type": (field.value_schema or {}).get("type", field.field_type)}
            for field in operation.request_body_fields
        },
        "required": [field.name for field in operation.request_body_fields if field.required],
    }


def _response_codes(operation: "ApiOperation") -> list[str]:
    return list(dict.fromkeys([*operation.response_codes, *operation.response_schemas]))


def _response_changes(before: "ApiOperation", after: "ApiOperation") -> list[ContractChange]:
    changes = []
    old_codes, new_codes = _response_codes(before), _response_codes(after)
    for code in old_codes:
        if code in new_codes:
            continue
        success = code.startswith("2")
        changes.append(ContractChange(
            severity="breaking" if success else "safe", location=f"response {code}",
            message="Success response removed; clients that expect it will treat the new response as an error." if success else "Response no longer documented.",
        ))
    for code in new_codes:
        if code not in old_codes:
            success = code.startswith("2")
            changes.append(ContractChange(
                severity="warning" if success else "safe", location=f"response {code}",
                message="New success response; check that clients accept it." if success else "New documented response.",
            ))
    for code in new_codes:
        if code in old_codes and code in before.response_schemas and code in after.response_schemas:
            changes += schema_changes(before.response_schemas[code], after.response_schemas[code], f"response {code}", "response", "$")
    return changes


# --- Schemas -----------------------------------------------------------------------------------


def schema_changes(before: Any, after: Any, location: str, direction: Direction, path: str = "", depth: int = 0) -> list[ContractChange]:
    if not isinstance(before, Mapping) or not isinstance(after, Mapping) or depth > MAX_SCHEMA_DEPTH:
        return []
    where = f"{location} {path}".strip() if path else location
    changes: list[ContractChange] = []

    def add(request: Severity, response: Severity, message: str) -> None:
        changes.append(ContractChange(severity=request if direction == "request" else response, location=where, message=message))

    old_types, new_types = _types(before), _types(after)
    if old_types and new_types and old_types - {"null"} != new_types - {"null"}:
        add("breaking", "breaking", f"Type changed from {_type_text(old_types)} to {_type_text(new_types)}.")
        return changes
    if "null" in old_types and "null" not in new_types:
        add("breaking", "safe", "No longer accepts null." if direction == "request" else "Is no longer null.")
    elif "null" in new_types and "null" not in old_types:
        add("safe", "warning", "Now accepts null." if direction == "request" else "Can now be null; check that clients handle it.")

    _enum_changes(before.get("enum"), after.get("enum"), add)
    _bound_changes(before, after, add)
    for rule in ("format", "pattern"):
        old_rule, new_rule = before.get(rule), after.get(rule)
        if old_rule == new_rule:
            continue
        if new_rule is None:
            add("safe", "warning", f"No longer has {rule} {old_rule!r}.")
        elif old_rule is None:
            add("breaking", "safe", f"Now has {rule} {new_rule!r}.")
        else:
            add("breaking", "warning", f"{rule.capitalize()} changed from {old_rule!r} to {new_rule!r}.")

    changes += _property_changes(before, after, location, direction, path, depth, add)
    old_items, new_items = before.get("items"), after.get("items")
    if isinstance(old_items, Mapping) and isinstance(new_items, Mapping):
        changes += schema_changes(old_items, new_items, location, direction, f"{path or '$'}[]", depth + 1)
    return changes


def _enum_changes(old: Any, new: Any, add) -> None:
    if old == new:
        return
    if isinstance(new, list) and not isinstance(old, list):
        add("breaking", "safe", f"Now limited to {_values(new)}.")
    elif isinstance(old, list) and not isinstance(new, list):
        add("safe", "warning", "No longer limited to a list of values.")
    elif isinstance(old, list) and isinstance(new, list):
        removed = [value for value in old if value not in new]
        added = [value for value in new if value not in old]
        if removed:
            add("breaking", "safe", f"No longer allows {_values(removed)}.")
        if added:
            add("safe", "warning", f"Now also allows {_values(added)}.")


def _bound_changes(before: Mapping[str, Any], after: Mapping[str, Any], add) -> None:
    for rule in (*LOWER_BOUNDS, *UPPER_BOUNDS):
        old, new = before.get(rule), after.get(rule)
        if old == new or isinstance(old, bool) or isinstance(new, bool):
            continue
        lower = rule in LOWER_BOUNDS
        if new is None:
            tighter = False
        elif old is None:
            tighter = True
        else:
            tighter = new > old if lower else new < old
        text = f"{rule} {'removed' if new is None else f'set to {new}' if old is None else f'changed from {old} to {new}'}"
        if tighter:
            add("breaking", "safe", f"Stricter: {text}.")
        else:
            add("safe", "warning", f"Looser: {text}.")


def _property_changes(before, after, location, direction: Direction, path: str, depth: int, add) -> list[ContractChange]:
    old_props = before.get("properties") if isinstance(before.get("properties"), Mapping) else {}
    new_props = after.get("properties") if isinstance(after.get("properties"), Mapping) else {}
    old_required = set(before.get("required") or []) if isinstance(before.get("required"), list) else set()
    new_required = set(after.get("required") or []) if isinstance(after.get("required"), list) else set()
    changes: list[ContractChange] = []
    base = path or ("$" if direction == "response" else "")

    def field(name: str) -> str:
        return f"{base}.{name}" if base else name

    def add_at(name: str, request: Severity, response: Severity, message: str) -> None:
        where = f"{location} {field(name)}"
        changes.append(ContractChange(severity=request if direction == "request" else response, location=where, message=message))

    for name, schema in new_props.items():
        if name not in old_props:
            required = name in new_required
            if direction == "request":
                add_at(name, "breaking" if required else "safe", "safe", "New required field; clients that do not send it will be rejected." if required else "New optional field.")
            else:
                add_at(name, "safe", "safe", "New field.")
            continue
        if name in new_required and name not in old_required:
            add_at(name, "breaking", "safe", "Now required." if direction == "request" else "Now always present.")
        elif name in old_required and name not in new_required:
            add_at(name, "safe", "breaking", "Now optional." if direction == "request" else "No longer always present; clients that rely on it may fail.")
        changes += schema_changes(old_props[name], schema, location, direction, field(name), depth + 1)
    for name in old_props:
        if name not in new_props:
            add_at(name, "warning", "breaking",
                   "Field removed; clients that still send it may be ignored or rejected." if direction == "request"
                   else "Field removed; clients that read it will fail.")
    if direction == "request" and after.get("additionalProperties") is False and before.get("additionalProperties") is not False:
        add("breaking", "safe", "No longer accepts undocumented fields.")
    return changes


def _types(schema: Mapping[str, Any]) -> set[str]:
    value = schema.get("type")
    types = set(value) if isinstance(value, list) else {value} if isinstance(value, str) else set()
    if schema.get("nullable") is True:
        types.add("null")
    return types


def _type_text(types: set[str]) -> str:
    return " or ".join(sorted(types - {"null"})) or "any"


def _values(values: list[Any]) -> str:
    shown = ", ".join(repr(value) for value in values[:5])
    return shown + (f" and {len(values) - 5} more" if len(values) > 5 else "")


# --- What to run again -------------------------------------------------------------------------


def _retest(operation: "ApiOperation", changes: list[ContractChange]) -> list[str]:
    """The endpoint's runnable checks a change touches: the valid request always, plus checks
    named after a changed input, and the authentication check when authentication changed."""
    relevant = [change for change in changes if change.severity != "safe"]
    names = {
        change.location.split(" ")[1] if change.location.startswith("parameter ") else change.location.split(" ", 2)[-1].split(".")[0]
        for change in relevant
        if change.location.startswith(("parameter ", "request body "))
    }
    auth = any(change.location == "authentication" for change in relevant)
    titles = []
    for scenario in operation.scenarios:
        if scenario.request_example is None:
            continue
        if (
            scenario.category == "happy_path"
            or (auth and scenario.category == "security_minded")
            or any(name and name in scenario.title for name in names)
        ):
            titles.append(scenario.title)
    return list(dict.fromkeys(titles))


# --- Reports -----------------------------------------------------------------------------------

SEVERITY_LABELS = {"breaking": "Breaking", "warning": "Warning", "safe": "Safe"}


def diff_markdown(diff: ContractDiff) -> str:
    """A report for a pull request comment: totals, then each endpoint's changes by severity."""
    totals = diff.totals
    title = diff.head_title if diff.head_title == diff.base_title else f"{diff.base_title} → {diff.head_title}"
    lines = [f"## Contract changes: {title} {diff.base_version} → {diff.head_version}", ""]
    if not diff.endpoints:
        lines.append("No changes to endpoints, parameters, request bodies, or responses.")
        return "\n".join(lines) + "\n"
    lines.append(
        f"**{totals['breaking']} breaking**, {totals['warning']} {'warning' if totals['warning'] == 1 else 'warnings'}, "
        f"{totals['safe']} safe {'change' if totals['safe'] == 1 else 'changes'} across {totals['endpoints']} "
        f"{'endpoint' if totals['endpoints'] == 1 else 'endpoints'}."
    )
    for severity in ("breaking", "warning", "safe"):
        rows = [(endpoint, change) for endpoint in diff.endpoints for change in endpoint.changes if change.severity == severity]
        if not rows:
            continue
        lines += ["", f"### {SEVERITY_LABELS[severity]}", "", "| Endpoint | Where | Change |", "|---|---|---|"]
        lines += [f"| `{endpoint.key}` | {_cell(change.location)} | {_cell(change.message)} |" for endpoint, change in rows]
    retest = [endpoint for endpoint in diff.endpoints if endpoint.retest]
    if retest:
        lines += ["", "### Run again", ""]
        lines += [f"- `{endpoint.key}`: {', '.join(endpoint.retest)}" for endpoint in retest]
    return "\n".join(lines) + "\n"


def _cell(text: str) -> str:
    return text.replace("|", "\\|").replace("\n", " ")
