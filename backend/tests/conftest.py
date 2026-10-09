import os
from collections.abc import Callable

# The test client calls the app as "testserver"; allow it before the app is imported.
os.environ.setdefault("API_QA_ALLOWED_HOSTS", "testserver")

import httpx  # noqa: E402
import pytest  # noqa: E402
from fastapi.testclient import TestClient  # noqa: E402

from app.api.workspace import get_store  # noqa: E402
from app.domain.store import WorkspaceStore  # noqa: E402
from app.main import app  # noqa: E402

Handler = Callable[[httpx.Request], httpx.Response]


@pytest.fixture(autouse=True)
def workspace_store():
    """Every test gets an empty in-memory workspace database instead of the real data/ file."""
    store = WorkspaceStore(":memory:")
    app.dependency_overrides[get_store] = lambda: store
    yield store
    app.dependency_overrides.pop(get_store, None)


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture
def mock_http(monkeypatch):
    """Route every outbound HTTPX AsyncClient request to a test handler instead of the network."""

    sent: list[httpx.Request] = []
    state: dict[str, Handler] = {"handler": lambda request: httpx.Response(200, json={})}

    def dispatch(request: httpx.Request) -> httpx.Response:
        request.read()
        sent.append(request)
        return state["handler"](request)

    real_async_client = httpx.AsyncClient

    class MockedAsyncClient(real_async_client):
        def __init__(self, *args, **kwargs):
            kwargs["transport"] = httpx.MockTransport(dispatch)
            super().__init__(*args, **kwargs)

    monkeypatch.setattr(httpx, "AsyncClient", MockedAsyncClient)

    class MockHttp:
        requests = sent

        def respond_with(self, handler: Handler) -> None:
            state["handler"] = handler

    return MockHttp()


@pytest.fixture
def sample_spec() -> dict:
    return {
        "openapi": "3.0.3",
        "info": {"title": "Pets", "version": "1.0"},
        "servers": [{"url": "http://127.0.0.1:8000"}, {"description": "missing url"}],
        "security": [{"key": []}],
        "components": {
            "securitySchemes": {
                "key": {"type": "apiKey", "in": "header", "name": "X-Key"},
                "bearer": {"type": "http", "scheme": "bearer"},
            },
            "schemas": {
                "Pet": {
                    "type": "object",
                    "required": ["name", "age"],
                    "properties": {
                        "name": {"type": "string", "minLength": 2, "maxLength": 20},
                        "age": {"type": "integer", "minimum": 0, "maximum": 30},
                        "email": {"type": "string", "format": "email"},
                        "kind": {"type": "string", "enum": ["cat", "dog"]},
                    },
                }
            },
            "requestBodies": {
                "PetBody": {
                    "required": True,
                    "content": {"application/json": {"schema": {"$ref": "#/components/schemas/Pet"}}},
                }
            },
            "parameters": {
                "Limit": {"name": "limit", "in": "query", "schema": {"type": "integer", "default": 10}}
            },
        },
        "paths": {
            "/pets": {
                "get": {
                    "summary": "List pets",
                    "tags": ["pets"],
                    "parameters": [
                        {"$ref": "#/components/parameters/Limit"},
                        {"name": "owner", "in": "query", "required": True, "schema": {"type": "string"}},
                    ],
                    "responses": {"200": {}},
                },
                "post": {
                    "security": [{"bearer": []}],
                    "requestBody": {"$ref": "#/components/requestBodies/PetBody"},
                    "responses": {"201": {}, "422": {}},
                },
            },
            "/pets/{id}": {
                "parameters": [
                    {"name": "id", "in": "path", "required": True, "schema": {"type": "string", "example": "p1"}}
                ],
                "get": {"responses": {"200": {}, "404": {}}},
                "delete": {"security": [], "responses": {"204": {}}},
            },
            "/upload": {
                "post": {
                    "security": [],
                    "requestBody": {
                        "required": True,
                        "content": {
                            "multipart/form-data": {
                                "schema": {
                                    "type": "object",
                                    "required": ["file"],
                                    "properties": {
                                        "file": {"type": "string", "format": "binary"},
                                        "note": {"type": "string", "example": "hi"},
                                    },
                                }
                            }
                        },
                    },
                    "responses": {"200": {}},
                }
            },
            "/xml": {
                "post": {
                    "security": [],
                    "requestBody": {"content": {"application/xml": {"schema": {"type": "object"}}}},
                    "responses": {"200": {}},
                }
            },
        },
    }
