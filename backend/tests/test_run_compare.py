import json

import httpx

from app.cli import main
from app.domain.run_compare import CheckRecord, compare_runs


def record(endpoint, title, result, duration_ms=100, message=""):
    return CheckRecord(endpoint=endpoint, title=title, result=result, duration_ms=duration_ms, message=message)


def test_groups_each_check_by_how_it_changed():
    before = [
        record("GET /a", "Valid request", "PASS"),
        record("GET /b", "Valid request", "FAIL", message="Expected HTTP 200, received HTTP 500."),
        record("GET /c", "Valid request", "FAIL", message="old reason"),
        record("GET /d", "Valid request", "PASS", duration_ms=100),
        record("GET /e", "Valid request", "PASS", duration_ms=100),
        record("GET /gone", "Valid request", "PASS"),
        record("GET /f", "Valid request", "PASS"),
    ]
    after = [
        record("GET /a", "Valid request", "ERROR", message="Could not connect."),
        record("GET /b", "Valid request", "PASS"),
        record("GET /c", "Valid request", "FAIL", message="new reason"),
        record("GET /d", "Valid request", "PASS", duration_ms=160),
        record("GET /e", "Valid request", "PASS", duration_ms=140),
        record("GET /new", "Valid request", "PASS"),
        record("GET /f", "Valid request", "SKIPPED"),
    ]

    comparison = compare_runs(before, after)

    assert [item.endpoint for item in comparison.newly_failing] == ["GET /a"]
    assert [item.endpoint for item in comparison.fixed] == ["GET /b"]
    assert [(item.endpoint, item.message_changed) for item in comparison.still_failing] == [("GET /c", True)]
    # 60% and 60 ms slower counts; 40% does not.
    assert [item.endpoint for item in comparison.slower] == ["GET /d"]
    # A skipped check did not run, so it is only in the earlier results.
    assert [item.endpoint for item in comparison.only_before] == ["GET /f", "GET /gone"]
    assert [item.endpoint for item in comparison.only_after] == ["GET /new"]
    assert comparison.unchanged_passing == 1
    assert comparison.totals["newly_failing"] == 1


def test_a_small_absolute_slowdown_is_not_slower():
    comparison = compare_runs([record("GET /a", "x", "PASS", duration_ms=20)], [record("GET /a", "x", "PASS", duration_ms=60)])

    assert comparison.slower == []
    assert comparison.unchanged_passing == 1


def test_the_latest_record_of_a_check_wins():
    before = [record("GET /a", "x", "FAIL"), record("GET /a", "x", "PASS")]

    assert compare_runs(before, [record("GET /a", "x", "FAIL")]).newly_failing[0].endpoint == "GET /a"


def test_compare_route(client):
    payload = {
        "before": [{"endpoint": "GET /a", "title": "x", "result": "PASS", "duration_ms": 10, "run_id": "1"}],
        "after": [{"endpoint": "GET /a", "title": "x", "result": "FAIL", "duration_ms": 10, "run_id": "2", "message": "HTTP 500"}],
    }

    response = client.post("/api/v1/runs/compare", json=payload)

    assert response.status_code == 200
    body = response.json()
    assert body["totals"]["newly_failing"] == 1
    assert body["newly_failing"][0]["after"]["run_id"] == "2"


CONTRACT = {
    "openapi": "3.0.3",
    "info": {"title": "Pets", "version": "1.0"},
    "servers": [{"url": "http://127.0.0.1:8000"}],
    "paths": {"/pets": {"get": {"responses": {"200": {}}}}, "/owners": {"get": {"responses": {"200": {}}}}},
}


def run_cli(tmp_path, mock_http, failing_paths, *extra):
    spec = tmp_path / "openapi.json"
    spec.write_text(json.dumps(CONTRACT))
    mock_http.respond_with(lambda request: httpx.Response(500 if request.url.path in failing_paths else 200, json={}))
    return main(["run", "--spec", str(spec), *extra])


def test_cli_baseline_lists_changes_and_fail_on_new(tmp_path, mock_http, capsys):
    baseline = tmp_path / "before.json"
    assert run_cli(tmp_path, mock_http, {"/owners"}, "--json", str(baseline)) == 1

    # /owners still fails and /pets newly fails: only the new failure counts with --fail-on new.
    after = tmp_path / "after.json"
    code = run_cli(tmp_path, mock_http, {"/owners", "/pets"}, "--baseline", str(baseline), "--fail-on", "new", "--json", str(after))
    assert code == 1
    assert "1 newly failing, 0 fixed, 1 still failing" in capsys.readouterr().err
    assert json.loads(after.read_text())["comparison"]["totals"]["newly_failing"] == 1

    # Only the known failure is left: --fail-on new passes, the default still fails.
    assert run_cli(tmp_path, mock_http, {"/owners"}, "--baseline", str(baseline), "--fail-on", "new") == 0
    assert run_cli(tmp_path, mock_http, {"/owners"}, "--baseline", str(baseline)) == 1


def test_cli_fail_on_new_needs_a_baseline(tmp_path, mock_http, capsys):
    assert run_cli(tmp_path, mock_http, set(), "--fail-on", "new") == 2
    assert "--fail-on new needs --baseline" in capsys.readouterr().err


def test_cli_rejects_a_baseline_that_is_not_a_report(tmp_path, mock_http, capsys):
    other = tmp_path / "other.json"
    other.write_text(json.dumps({"hello": "world"}))

    assert run_cli(tmp_path, mock_http, set(), "--baseline", str(other)) == 2
    assert "is not an api-qa run --json report" in capsys.readouterr().err
    assert mock_http.requests == []


def test_cli_writes_an_html_report_with_the_comparison(tmp_path, mock_http):
    baseline = tmp_path / "before.json"
    run_cli(tmp_path, mock_http, set(), "--json", str(baseline))
    html_path = tmp_path / "report.html"

    run_cli(tmp_path, mock_http, {"/pets"}, "--baseline", str(baseline), "--html", str(html_path), "--header", "X-Key: very-secret")

    html = html_path.read_text()
    assert html.startswith("<!doctype html>")
    assert "Changes since the baseline of" in html
    assert "Newly failing" in html
    assert "very-secret" not in html
