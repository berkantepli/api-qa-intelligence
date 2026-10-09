"""A small API with known, deliberate problems, used as the target in end-to-end tests.

- GET /pets passes every check.
- GET /pets/{id} returns a pet without its required name, so the schema check fails.
- GET /orders documents an API key but never asks for one, so "Call without authentication" fails.
- POST /pets creates a pet and validates its body.
"""

from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse

app = FastAPI(openapi_url=None, docs_url=None, redoc_url=None)

PET = {"type": "object", "required": ["id", "name"], "properties": {"id": {"type": "integer"}, "name": {"type": "string"}}}
CONTRACT = {
    "openapi": "3.0.3",
    "info": {"title": "E2E Pets", "version": "1.0.0"},
    "servers": [{"url": "/"}],
    "components": {"securitySchemes": {"key": {"type": "apiKey", "in": "header", "name": "X-Key"}}},
    "paths": {
        "/pets": {
            "get": {
                "summary": "List pets",
                "responses": {"200": {"description": "ok", "content": {"application/json": {"schema": {"type": "array", "items": PET}}}}},
            },
            "post": {
                "summary": "Create a pet",
                "requestBody": {"required": True, "content": {"application/json": {"schema": {
                    "type": "object", "required": ["name"], "properties": {"name": {"type": "string", "example": "Rex"}},
                }}}},
                "responses": {"201": {"description": "created"}, "422": {"description": "invalid"}},
            },
        },
        "/pets/{id}": {
            "get": {
                "summary": "Find a pet",
                "parameters": [{"name": "id", "in": "path", "required": True, "schema": {"type": "integer"}}],
                "responses": {
                    "200": {"description": "ok", "content": {"application/json": {"schema": PET}}},
                    "404": {"description": "missing"},
                },
            },
        },
        "/orders": {
            "get": {
                "summary": "List orders",
                "security": [{"key": []}],
                "responses": {"200": {"description": "ok"}, "401": {"description": "no key"}},
            },
        },
    },
}


@app.get("/openapi.json")
def contract() -> dict:
    return CONTRACT


@app.get("/pets")
def list_pets() -> list[dict]:
    return [{"id": 1, "name": "Rex"}]


@app.post("/pets")
async def create_pet(request: Request) -> JSONResponse:
    body = await request.json() if await request.body() else None
    if not isinstance(body, dict) or not isinstance(body.get("name"), str):
        return JSONResponse({"detail": "name is required"}, status_code=422)
    return JSONResponse({"id": 2, "name": body["name"]}, status_code=201)


@app.get("/pets/{pet_id}")
def find_pet(pet_id: str) -> JSONResponse:
    if not pet_id.isdigit():
        return JSONResponse({"detail": "not found"}, status_code=404)
    return JSONResponse({"id": int(pet_id)})


@app.get("/orders")
def list_orders() -> list[dict]:
    return [{"id": 10}]
