import asyncio

import httpx
import pytest

from app.api import demo
from app.domain.execution import ScenarioExecutionRequest, execute_scenario
from app.domain.flows import FlowExecutionRequest, execute_flow
from app.domain.openapi import summarize_openapi
from app.domain.request_builder import build_check_request, describe_operation, request_readiness
from app.main import app

BASE_URL = "http://127.0.0.1:8001/demo"


@pytest.fixture(autouse=True)
def fresh_demo(monkeypatch):
    demo.store.reset()
    monkeypatch.setattr(demo, "SLOW_REPORT_SECONDS", 0.05)
    yield
    demo.store.reset()


@pytest.fixture
def demo_http(monkeypatch):
    """Outbound HTTPX requests go to this app in-process, so checks reach the demo API without a server."""
    real_async_client = httpx.AsyncClient

    class InProcessClient(real_async_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.ASGITransport(app=app)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", InProcessClient)


def sign_in(client, email: str = demo.DEMO_EMAIL, password: str = demo.DEMO_PASSWORD) -> str:
    response = client.post("/demo/auth/login", json={"email": email, "password": password})
    assert response.status_code == 200
    return response.json()["access_token"]


def test_info_names_the_contract_on_this_server(client):
    info = client.get("/api/v1/demo").json()

    assert info == {"spec_url": "http://127.0.0.1:80/demo/openapi.json", "base_url": "http://127.0.0.1:80/demo"}
    assert client.get("/demo/openapi.json").json()["info"]["title"] == "Demo Bookstore"


def test_the_demo_is_not_part_of_the_app_api_docs(client):
    paths = client.get("/openapi.json").json()["paths"]

    assert "/api/v1/demo" in paths
    assert not any(path.startswith("/demo") for path in paths)


def test_sign_in_and_protected_endpoints(client):
    assert client.post("/demo/auth/login", json={"email": demo.DEMO_EMAIL, "password": "wrong"}).status_code == 401
    assert client.get("/demo/me").status_code == 401
    token = sign_in(client)

    assert client.get("/demo/me", headers={"Authorization": f"Bearer {token}"}).json()["email"] == demo.DEMO_EMAIL
    assert client.get("/demo/me", headers={"Authorization": "Bearer made-up"}).status_code == 401


def test_books_can_be_created_read_and_deleted_then_reset(client):
    headers = {"Authorization": f"Bearer {sign_in(client)}"}
    book = {"title": "Dune", "author": "Frank Herbert", "year": 1965, "genre": "fiction", "price": 9.99}

    created = client.post("/demo/books", json=book, headers=headers)
    assert created.status_code == 201
    assert created.headers["location"] == f"/demo/books/{created.json()['id']}"
    assert client.get(f"/demo/books/{created.json()['id']}").json()["title"] == "Dune"
    assert client.delete("/demo/books/2", headers=headers).status_code == 204
    assert client.get("/demo/books/2").status_code == 404

    assert client.post("/demo/__reset").status_code == 204
    assert client.get("/demo/books/2").status_code == 200
    assert client.get(f"/demo/books/{created.json()['id']}").status_code == 404


def test_only_the_owner_deletes_a_book_but_anyone_signed_in_replaces_it(client):
    owner = {"Authorization": f"Bearer {sign_in(client)}"}
    second = {"Authorization": f"Bearer {sign_in(client, demo.SECOND_EMAIL, demo.SECOND_PASSWORD)}"}
    book = {"title": "Dune", "author": "Frank Herbert", "year": 1965, "genre": "fiction", "price": 9.99}
    book_id = client.post("/demo/books", json=book, headers=owner).json()["id"]

    assert client.get("/demo/me", headers=second).json()["email"] == demo.SECOND_EMAIL
    assert client.delete(f"/demo/books/{book_id}", headers=second).status_code == 403
    # Deliberate: replacing another reader's book is not refused.
    assert client.put(f"/demo/books/{book_id}", json={**book, "title": "Changed"}, headers=second).status_code == 200
    assert client.delete(f"/demo/books/{book_id}", headers=owner).status_code == 204
    # The sample books have no owner, so any signed-in reader may still delete them.
    assert client.delete("/demo/books/1", headers=second).status_code == 204


def test_memory_stays_bounded(client, monkeypatch):
    monkeypatch.setattr(demo, "MAX_BOOKS", 5)
    headers = {"Authorization": f"Bearer {sign_in(client)}"}
    for _ in range(8):
        client.post("/demo/books", json={"title": "T", "author": "A", "year": 2000, "genre": "history", "price": 1}, headers=headers)

    assert len(demo.store.books) == 5
    assert set(demo.SEED_BOOKS) <= set(demo.store.books)


def run_contract_checks(token: str, time_limit_ms: int | None = None) -> dict[tuple[str, str], str]:
    """Runs every runnable contract check the way `api-qa run --include-writes` does."""
    overview = summarize_openapi(demo.CONTRACT)
    results: dict[tuple[str, str], str] = {}

    async def run() -> None:
        for operation in overview.operations:
            key = f"{operation.method} {operation.path}"
            described = describe_operation(operation)
            inputs = {"parameter:path:orderId": "ORD-1001"} if operation.path == "/orders/{orderId}" else {}
            assert request_readiness(described, inputs).ready, key
            for scenario in operation.scenarios:
                if scenario.request_example is None:
                    continue
                payload = build_check_request(described, inputs, scenario, BASE_URL, {"Authorization": f"Bearer {token}"})
                payload["max_duration_ms"] = time_limit_ms
                result = await execute_scenario(ScenarioExecutionRequest.model_validate(payload))
                results[(key, scenario.title)] = result.result

    asyncio.run(run())
    return results


def test_contract_checks_find_exactly_the_deliberate_problems(client, demo_http):
    results = run_contract_checks(sign_in(client))
    failed = {check for check, result in results.items() if result != "PASS"}

    assert failed == {
        ("GET /books", "Valid request"),  # a price that is text breaks the schema
        ("GET /orders", "Call without authentication"),  # no token is checked
        ("POST /books", "Check boundary values for year"),  # 1450 is rejected
        ("POST /books", "Send the wrong type for year"),
        ("POST /books", "Send an undocumented request field"),
        ("PUT /books/{bookId}", "Check boundary values for year"),
        ("PUT /books/{bookId}", "Send the wrong type for year"),
        ("PUT /books/{bookId}", "Send an undocumented request field"),
    }
    assert len(results) > 30


def test_a_time_limit_catches_the_slow_report(client, demo_http, monkeypatch):
    monkeypatch.setattr(demo, "SLOW_REPORT_SECONDS", 0.3)

    results = run_contract_checks(sign_in(client), time_limit_ms=200)

    assert results[("GET /reports/sales", "Valid request")] == "FAIL"
    assert results[("GET /health", "Valid request")] == "PASS"


def test_the_suggested_lifecycle_flow_passes(client, demo_http):
    overview = summarize_openapi(demo.CONTRACT)
    flow = next(item for item in overview.flows if item.title == "Book lifecycle")
    request = FlowExecutionRequest(base_url=BASE_URL, headers={"Authorization": f"Bearer {sign_in(client)}"}, steps=flow.steps)

    outcome = asyncio.run(execute_flow(request))

    assert outcome.result == "PASS", [(step.name, step.result) for step in outcome.steps]
    assert len(outcome.steps) >= 4
