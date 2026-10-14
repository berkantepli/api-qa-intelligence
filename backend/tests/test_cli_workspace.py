import copy
import json

import httpx
import pytest
from tests.test_cli import CONTRACT, flow_api, pets_api

from app.cli import main
from app.domain.openapi import summarize_openapi

EDITED_CHECK = {
    "category": "negative",
    "title": "Unknown pet id",
    "rationale": "An id that does not exist.",
    "review_required": True,
    "source": "ai_edited",
    "draft": {"title": "Unknown pet id"},
    "request_example": {
        "method": "GET",
        "path": "/pets/{id}",
        "parameter_values": {"path:id": "999"},
        "expected_status_codes": [404],
    },
}
CUSTOM_FLOW = {
    "id": "custom-list-twice",
    "title": "List pets twice",
    "resource": "",
    "source": "custom",
    "rationale": "A flow you built.",
    "edited": False,
    "steps": [
        {"title": "First list", "method": "GET", "path": "/pets", "headers": {}, "expected_status_codes": [200]},
        {"title": "Second list", "method": "GET", "path": "/pets", "expected_status_codes": [200]},
    ],
}


def saved_api(**changes):
    overview = summarize_openapi(CONTRACT).model_dump(mode="json")
    pet = next(operation for operation in overview["operations"] if operation["path"] == "/pets/{id}")
    pet["scenarios"].append(EDITED_CHECK)
    return {"id": "api-1", "title": "Pets", "overview": overview, **changes}


def write_workspace(tmp_path, *apis, **fields):
    path = tmp_path / "workspace.json"
    data = {"format": "api-qa-intelligence-workspace", "version": 1, "exportedAt": "2026-10-14T00:00:00Z", "savedApis": list(apis), "runHistory": []}
    path.write_text(json.dumps({**data, **fields}))
    return str(path)


def answer_unknown_pets(request: httpx.Request) -> httpx.Response:
    if request.url.path == "/v1/pets/999":
        return httpx.Response(404, json={"message": "not found"})
    return flow_api(request)


def test_runs_edited_checks_and_saved_flows(tmp_path, mock_http):
    mock_http.respond_with(answer_unknown_pets)
    api = saved_api(customFlows=[CUSTOM_FLOW])
    suggested = api["overview"]["flows"][0]
    api["flowEdits"] = {suggested["id"]: {**suggested, "title": "Create and read, edited", "edited": True}}
    workspace = write_workspace(tmp_path, api)

    code = main([
        "run", "--workspace", workspace, "--header", "X-Key: secret", "--param", "id=7",
        "--include-writes", "--flows", "--json", str(tmp_path / "r.json"),
    ])

    report = json.loads((tmp_path / "r.json").read_text())
    assert code == 0
    pet = next(endpoint for endpoint in report["endpoints"] if endpoint["path"] == "/pets/{id}")
    assert [check["title"] for check in pet["checks"]][-1] == "Unknown pet id"
    assert pet["checks"][-1]["result"]["result"] == "PASS"
    assert "http://127.0.0.1:8000/v1/pets/999" in [str(request.url) for request in mock_http.requests]
    # The edit replaces its suggestion; the flow the user built runs after it.
    assert [flow["title"] for flow in report["flows"]] == ["Create and read, edited", "List pets twice"]
    assert report["totals"]["flows_passed"] == 2


def test_the_target_saved_in_the_app_is_used_without_target(tmp_path, mock_http):
    mock_http.respond_with(lambda request: httpx.Response(200, json=[{"name": "Rex"}]))
    api = saved_api(targetUrl="http://127.0.0.1:9000/v1")
    api["overview"]["servers"] = []
    workspace = write_workspace(tmp_path, api)

    main(["run", "--workspace", workspace, "--endpoint", "GET /pets", "--allow-private-network"])
    main(["run", "--workspace", workspace, "--endpoint", "GET /pets", "--target", "http://127.0.0.1:9100", "--allow-private-network"])

    hosts = {request.url.port for request in mock_http.requests}
    assert hosts == {9000, 9100}


def test_choosing_one_of_several_apis(tmp_path, mock_http, capsys):
    mock_http.respond_with(pets_api)
    other = {**saved_api(), "id": "api-2", "title": "Orders"}
    workspace = write_workspace(tmp_path, saved_api(), other)

    assert main(["run", "--workspace", workspace]) == 2
    assert "The workspace has 2 APIs ('Pets', 'Orders'); choose one with --api." in capsys.readouterr().err
    assert main(["run", "--workspace", workspace, "--api", "orders", "--endpoint", "GET /pets", "--header", "X-Key: secret"]) == 0
    assert main(["run", "--workspace", workspace, "--api", "api-1", "--endpoint", "GET /pets", "--header", "X-Key: secret"]) == 0
    assert main(["run", "--workspace", workspace, "--api", "Users"]) == 2
    assert "No API called 'Users' in the workspace. Its APIs: 'Pets', 'Orders'." in capsys.readouterr().err


def test_a_flow_that_cannot_be_read_is_reported_as_skipped(tmp_path, mock_http):
    mock_http.respond_with(pets_api)
    broken = copy.deepcopy(CUSTOM_FLOW) | {"title": "Broken", "steps": []}
    workspace = write_workspace(tmp_path, saved_api(customFlows=[broken]))

    code = main(["run", "--workspace", workspace, "--include-writes", "--flows", "--param", "id=7", "--header", "X-Key: secret",
                 "--json", str(tmp_path / "r.json"), "--fail-on-skipped"])

    flows = json.loads((tmp_path / "r.json").read_text())["flows"]
    assert flows[-1]["title"] == "Broken"
    assert flows[-1]["skipped_reason"] == "Could not be read from the workspace file; open and save it in the app again."
    assert code == 1


@pytest.mark.parametrize(("contents", "message"), [
    ("not json", "The workspace file is not valid JSON."),
    (json.dumps({"openapi": "3.0.3"}), "This is not an API QA Intelligence workspace export."),
    (json.dumps({"format": "api-qa-intelligence-workspace", "version": 2}), "exported by a newer version"),
    (json.dumps({"format": "api-qa-intelligence-workspace", "version": 1, "savedApis": []}), "The workspace file has no saved APIs."),
])
def test_files_that_are_not_usable_workspaces_exit_2(tmp_path, capsys, contents, message):
    path = tmp_path / "workspace.json"
    path.write_text(contents)

    assert main(["run", "--workspace", str(path)]) == 2
    assert message in capsys.readouterr().err


def test_api_needs_workspace_and_sources_are_exclusive(tmp_path, capsys):
    workspace = write_workspace(tmp_path, saved_api())

    assert main(["run", "--spec", "openapi.json", "--api", "Pets"]) == 2
    assert "--api chooses a saved API from --workspace" in capsys.readouterr().err
    assert main(["run", "--workspace", str(tmp_path / "missing.json")]) == 2
    assert "The workspace could not be read from" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        main(["run", "--spec", "openapi.json", "--workspace", workspace])
