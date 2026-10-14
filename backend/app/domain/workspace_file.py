"""Reads a workspace exported from the app's Settings page, so the CLI can run the checks and flows
saved in the browser: edited AI checks, edited suggested flows, and flows the user built.

The export never holds credentials; they still come from --header, --param, or --inputs.
"""

import json
from dataclasses import dataclass, field
from typing import Any

from pydantic import ValidationError

from app.domain.flows import ApiFlow
from app.domain.openapi import ApiOverview

WORKSPACE_FORMAT = "api-qa-intelligence-workspace"
WORKSPACE_VERSION = 1


class WorkspaceFileError(ValueError):
    """The file is not a usable workspace export, or the API to run cannot be chosen."""


@dataclass
class WorkspaceApi:
    title: str
    overview: ApiOverview
    flows: list[ApiFlow]
    # The target URL last used in the app, if any.
    target: str | None = None
    # Saved flows that could not be read, by title; reported instead of silently dropped.
    unreadable_flows: list[str] = field(default_factory=list)


def parse_workspace(text: str) -> list[dict[str, Any]]:
    try:
        data = json.loads(text)
    except ValueError as error:
        raise WorkspaceFileError("The workspace file is not valid JSON.") from error
    if not isinstance(data, dict) or data.get("format") != WORKSPACE_FORMAT:
        raise WorkspaceFileError("This is not an API QA Intelligence workspace export. Export one from Settings → Export workspace.")
    version = data.get("version")
    if isinstance(version, int) and version > WORKSPACE_VERSION:
        raise WorkspaceFileError("This workspace was exported by a newer version of API QA Intelligence. Update the CLI, then try again.")
    if version != WORKSPACE_VERSION:
        raise WorkspaceFileError(f"This workspace file has an unknown format version ({version!r}).")
    apis = data.get("savedApis")
    if not isinstance(apis, list) or not apis:
        raise WorkspaceFileError("The workspace file has no saved APIs.")
    if not all(isinstance(api, dict) and isinstance(api.get("title"), str) and isinstance(api.get("overview"), dict) for api in apis):
        raise WorkspaceFileError("A saved API in the workspace file is incomplete.")
    return apis


def choose_api(apis: list[dict[str, Any]], choice: str | None) -> dict[str, Any]:
    """Picks the saved API by id or title (case-insensitive); the only one when there is one."""
    names = ", ".join(repr(api["title"]) for api in apis)
    if choice is None:
        if len(apis) == 1:
            return apis[0]
        raise WorkspaceFileError(f"The workspace has {len(apis)} APIs ({names}); choose one with --api.")
    by_id = [api for api in apis if api.get("id") == choice]
    if by_id:
        return by_id[0]
    by_title = [api for api in apis if api["title"].strip().casefold() == choice.strip().casefold()]
    if len(by_title) == 1:
        return by_title[0]
    if by_title:
        ids = ", ".join(str(api.get("id")) for api in by_title)
        raise WorkspaceFileError(f"{len(by_title)} APIs are called {choice!r}; choose one by id with --api ({ids}).")
    raise WorkspaceFileError(f"No API called {choice!r} in the workspace. Its APIs: {names}.")


def effective_flows(api: dict[str, Any]) -> list[dict[str, Any]]:
    """Same order as the app's Flows page: suggestions (an edit replaces its flow), edits whose
    suggestion is gone, then the flows the user built."""
    edits = api.get("flowEdits") if isinstance(api.get("flowEdits"), dict) else {}
    suggested = api["overview"].get("flows") or []
    suggested_ids = {flow.get("id") for flow in suggested if isinstance(flow, dict)}
    custom = api.get("customFlows") if isinstance(api.get("customFlows"), list) else []
    return [
        *(edits.get(flow.get("id"), flow) if isinstance(flow, dict) else flow for flow in suggested),
        *(flow for flow_id, flow in edits.items() if flow_id not in suggested_ids),
        *custom,
    ]


def load_workspace_api(text: str, choice: str | None) -> WorkspaceApi:
    api = choose_api(parse_workspace(text), choice)
    try:
        overview = ApiOverview.model_validate({**api["overview"], "flows": []})
    except ValidationError as error:
        raise WorkspaceFileError(f"The saved API {api['title']!r} could not be read; import its contract in the app again and export anew.") from error
    flows, unreadable = [], []
    for flow in effective_flows(api):
        try:
            parsed = ApiFlow.model_validate(flow)
            if not parsed.steps:
                raise ValueError("A flow needs at least one step.")
            flows.append(parsed)
        except ValueError:
            unreadable.append(str(flow.get("title") or flow.get("id") or "untitled") if isinstance(flow, dict) else "untitled")
    target = api.get("targetUrl")
    return WorkspaceApi(
        title=api["title"],
        overview=overview,
        flows=flows,
        target=target.strip() if isinstance(target, str) and target.strip() else None,
        unreadable_flows=unreadable,
    )
