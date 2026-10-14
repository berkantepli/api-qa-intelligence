"""A small bookstore API served by this app under /demo, with deliberate problems for the checks
to find. It needs no internet, so the app can be tried end to end on any machine.

Deliberate problems (each one is found by a contract check, a flow, or a time limit):
- GET /books lists a book whose price is text instead of a number (the schema check fails).
- GET /orders documents bearer authentication but answers without it.
- POST and PUT /books accept a year that is not a number and fields the schema forbids, and
  reject the lowest documented year (1450) as if the minimum were exclusive.
- GET /reports/sales takes about 1.5 seconds, so a response time limit of 1000 ms fails it.
- PUT /books/{bookId} lets any signed-in reader replace a book another reader added (DELETE checks
  the owner), so the access check of the book flow finds it with the second demo account.
Everything else behaves as documented, so most checks pass.
"""

import asyncio
import secrets
import threading
from collections import OrderedDict
from copy import deepcopy
from typing import Any

from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel

DEMO_PREFIX = "/demo"
DEMO_EMAIL = "demo@example.com"
DEMO_PASSWORD = "demo-password"
# A second reader, so access checks can try one reader's book with another's token.
SECOND_EMAIL = "second@example.com"
SECOND_PASSWORD = "second-password"
MAX_TOKENS = 1000
SLOW_REPORT_SECONDS = 1.5
MAX_BOOKS = 200
GENRES = ["fiction", "science", "history"]

SEED_BOOKS = {
    1: {"id": 1, "title": "The Left Hand of Darkness", "author": "Ursula K. Le Guin", "year": 1969, "genre": "fiction", "price": 14.5},
    2: {"id": 2, "title": "A Brief History of Time", "author": "Stephen Hawking", "year": 1988, "genre": "science", "price": 18.0},
    # Deliberate: the price is text, which the documented schema does not allow.
    3: {"id": 3, "title": "The Dispossessed", "author": "Ursula K. Le Guin", "year": 1974, "genre": "fiction", "price": "12.00"},
}
ORDERS = {
    "ORD-1001": {"id": "ORD-1001", "book_id": 1, "quantity": 2, "status": "shipped"},
    "ORD-1002": {"id": "ORD-1002", "book_id": 2, "quantity": 1, "status": "processing"},
}
USER = {"id": 7, "email": DEMO_EMAIL, "name": "Demo Reader"}
SECOND_USER = {"id": 8, "email": SECOND_EMAIL, "name": "Second Reader"}
ACCOUNTS = {DEMO_EMAIL: (DEMO_PASSWORD, USER), SECOND_EMAIL: (SECOND_PASSWORD, SECOND_USER)}


class DemoStore:
    """In-memory books and sign-in tokens; reset on start and with POST /demo/__reset."""

    def __init__(self) -> None:
        self.lock = threading.Lock()
        # Sign-in token -> the reader's email, the oldest dropped first.
        self.tokens: OrderedDict[str, str] = OrderedDict()
        self.reset()

    def reset(self) -> None:
        with self.lock:
            self.books: dict[int, dict[str, Any]] = deepcopy(SEED_BOOKS)
            # Who added each book; the sample books have no owner, so any reader may change them.
            self.owners: dict[int, str] = {}
            self.next_id = max(self.books) + 1

    def sign_in(self, email: str) -> str:
        token = secrets.token_urlsafe(24)
        with self.lock:
            self.tokens[token] = email
            while len(self.tokens) > MAX_TOKENS:
                self.tokens.popitem(last=False)
        return token

    def add(self, book: dict[str, Any], owner: str) -> dict[str, Any]:
        with self.lock:
            # Keeps memory bounded however many books a bulk run creates.
            while len(self.books) >= MAX_BOOKS:
                oldest = min(key for key in self.books if key not in SEED_BOOKS)
                del self.books[oldest]
                self.owners.pop(oldest, None)
            book = {"id": self.next_id, **book}
            self.books[self.next_id] = book
            self.owners[self.next_id] = owner
            self.next_id += 1
            return book


store = DemoStore()
router = APIRouter(prefix=DEMO_PREFIX, include_in_schema=False)
info_router = APIRouter(prefix="/api/v1/demo", tags=["Demo"])


class DemoInfo(BaseModel):
    spec_url: str
    base_url: str


@info_router.get("", response_model=DemoInfo)
def demo_info(request: Request) -> DemoInfo:
    """Where this app serves the demo API, as the backend itself reaches it."""
    server = request.scope.get("server") or ("127.0.0.1", 8001)
    base_url = f"http://127.0.0.1:{server[1]}{DEMO_PREFIX}"
    return DemoInfo(spec_url=f"{base_url}/openapi.json", base_url=base_url)


def _error(status: int, detail: str) -> JSONResponse:
    return JSONResponse({"detail": detail}, status_code=status)


def _reader(request: Request) -> str | None:
    """The signed-in reader's email, or None."""
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    return store.tokens.get(token) if scheme.lower() == "bearer" else None


def _signed_in(request: Request) -> bool:
    return _reader(request) is not None


def _book_id(value: str) -> int | None:
    return int(value) if value.isdigit() else None


def _validate_book(body: Any) -> tuple[dict[str, Any] | None, str | None]:
    if not isinstance(body, dict):
        return None, "The body must be a JSON object."
    for field in ("title", "author", "year", "genre", "price"):
        if field not in body:
            return None, f"{field} is required."
    if not isinstance(body["title"], str) or not body["title"].strip() or len(body["title"]) > 120:
        return None, "title must be text of 1 to 120 characters."
    if not isinstance(body["author"], str) or not body["author"].strip():
        return None, "author must be text."
    # Deliberate: a year that is not a number is accepted, and the documented minimum is exclusive here.
    if isinstance(body["year"], int) and not 1450 < body["year"] <= 2100:
        return None, "year must be after 1450 and at most 2100."
    if body["genre"] not in GENRES:
        return None, f"genre must be one of {', '.join(GENRES)}."
    if not isinstance(body["price"], (int, float)) or isinstance(body["price"], bool) or body["price"] < 0:
        return None, "price must be a number of at least 0."
    # Deliberate: fields the schema forbids (additionalProperties: false) are silently ignored.
    return {field: body[field] for field in ("title", "author", "year", "genre", "price")}, None


async def _json(request: Request) -> Any:
    try:
        return await request.json()
    except ValueError:
        return None


@router.get("/openapi.json")
def demo_contract() -> dict[str, Any]:
    return CONTRACT


@router.post("/__reset")
def reset_demo() -> Response:
    """Not in the contract: brings back the three sample books."""
    store.reset()
    return Response(status_code=204)


@router.get("/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@router.post("/auth/login")
async def login(request: Request) -> JSONResponse:
    body = await _json(request)
    if not isinstance(body, dict) or not isinstance(body.get("email"), str) or not isinstance(body.get("password"), str):
        return _error(422, "email and password are required.")
    if "@" not in body["email"]:
        return _error(422, "email must be an email address.")
    account = ACCOUNTS.get(body["email"])
    if account is None or body["password"] != account[0]:
        return _error(401, "Wrong email or password.")
    return JSONResponse({"access_token": store.sign_in(body["email"]), "token_type": "bearer", "expires_in": 3600})


@router.get("/me")
def me(request: Request) -> JSONResponse:
    reader = _reader(request)
    if reader is None:
        return _error(401, "Sign in first.")
    return JSONResponse(ACCOUNTS[reader][1])


@router.get("/books")
def list_books(request: Request) -> JSONResponse:
    limit_text = request.query_params.get("limit", "10")
    if not limit_text.isdigit() or not 1 <= int(limit_text) <= 50:
        return _error(400, "limit must be a whole number from 1 to 50.")
    genre = request.query_params.get("genre")
    if genre is not None and genre not in GENRES:
        return _error(400, f"genre must be one of {', '.join(GENRES)}.")
    books = [book for book in store.books.values() if genre is None or book["genre"] == genre]
    return JSONResponse(books[: int(limit_text)])


@router.post("/books")
async def create_book(request: Request) -> JSONResponse:
    reader = _reader(request)
    if reader is None:
        return _error(401, "Sign in first.")
    book, problem = _validate_book(await _json(request))
    if problem:
        return _error(422, problem)
    created = store.add(book, reader)
    return JSONResponse(created, status_code=201, headers={"Location": f"{DEMO_PREFIX}/books/{created['id']}"})


@router.get("/books/{book_id}")
def get_book(book_id: str) -> JSONResponse:
    key = _book_id(book_id)
    if key is None:
        return _error(400, "bookId must be a whole number.")
    book = store.books.get(key)
    return JSONResponse(book) if book else _error(404, "No book with this id.")


@router.put("/books/{book_id}")
async def update_book(book_id: str, request: Request) -> JSONResponse:
    if not _signed_in(request):
        return _error(401, "Sign in first.")
    key = _book_id(book_id)
    if key is None:
        return _error(400, "bookId must be a whole number.")
    if key not in store.books:
        return _error(404, "No book with this id.")
    # Deliberate: the owner is not checked, so any reader can replace another reader's book.
    book, problem = _validate_book(await _json(request))
    if problem:
        return _error(422, problem)
    with store.lock:
        store.books[key] = {"id": key, **book}
    return JSONResponse(store.books[key])


@router.delete("/books/{book_id}")
def delete_book(book_id: str, request: Request) -> Response:
    reader = _reader(request)
    if reader is None:
        return _error(401, "Sign in first.")
    key = _book_id(book_id)
    if key is None:
        return _error(400, "bookId must be a whole number.")
    with store.lock:
        if key not in store.books:
            return _error(404, "No book with this id.")
        owner = store.owners.get(key)
        if owner is not None and owner != reader:
            return _error(403, "Only the reader who added this book can delete it.")
        del store.books[key]
        store.owners.pop(key, None)
    return Response(status_code=204)


@router.get("/orders")
def list_orders() -> JSONResponse:
    # Deliberate: the contract requires a bearer token here, but none is checked.
    return JSONResponse(list(ORDERS.values()))


@router.get("/orders/{order_id}")
def get_order(order_id: str, request: Request) -> JSONResponse:
    if not _signed_in(request):
        return _error(401, "Sign in first.")
    order = ORDERS.get(order_id)
    return JSONResponse(order) if order else _error(404, "No order with this id.")


@router.get("/reports/sales")
async def sales_report() -> JSONResponse:
    # Deliberate: slow enough that a 1000 ms response time limit fails it.
    await asyncio.sleep(SLOW_REPORT_SECONDS)
    return JSONResponse({"orders": len(ORDERS), "books_sold": sum(order["quantity"] for order in ORDERS.values()), "revenue": 47.0})


def _response(description: str, schema: dict[str, Any] | None = None) -> dict[str, Any]:
    return {"description": description, **({"content": {"application/json": {"schema": schema}}} if schema else {})}


ERROR = {"type": "object", "required": ["detail"], "properties": {"detail": {"type": "string"}}}
BOOK = {"$ref": "#/components/schemas/Book"}
BOOK_INPUT_BODY = {"required": True, "content": {"application/json": {"schema": {"$ref": "#/components/schemas/BookInput"}}}}
BOOK_ID = {"name": "bookId", "in": "path", "required": True, "description": "The book's id.", "schema": {"type": "integer", "minimum": 1}}
AUTH = [{"bearer": []}]
SIGN_IN_PROBLEMS = {"401": _response("Missing or invalid bearer token.", ERROR)}

CONTRACT: dict[str, Any] = {
    "openapi": "3.0.3",
    "info": {
        "title": "Demo Bookstore",
        "version": "1.0.0",
        "description": "A bookstore API built into API QA Intelligence, with deliberate problems for the checks to find. "
        f"Sign in with {DEMO_EMAIL} / {DEMO_PASSWORD}; a second reader, {SECOND_EMAIL} / {SECOND_PASSWORD}, "
        "is there for access checks.",
    },
    "servers": [{"url": DEMO_PREFIX}],
    "tags": [{"name": "Books"}, {"name": "Orders"}, {"name": "Account"}, {"name": "Reports"}],
    "components": {
        "securitySchemes": {"bearer": {"type": "http", "scheme": "bearer", "description": "The access_token from POST /auth/login."}},
        "schemas": {
            "Book": {
                "type": "object",
                "required": ["id", "title", "author", "year", "genre", "price"],
                "properties": {
                    "id": {"type": "integer", "example": 1},
                    "title": {"type": "string", "example": "Dune"},
                    "author": {"type": "string", "example": "Frank Herbert"},
                    "year": {"type": "integer", "example": 1965},
                    "genre": {"type": "string", "enum": GENRES},
                    "price": {"type": "number", "example": 9.99},
                },
            },
            "BookInput": {
                "type": "object",
                "additionalProperties": False,
                "required": ["title", "author", "year", "genre", "price"],
                "properties": {
                    "title": {"type": "string", "maxLength": 120, "example": "Dune"},
                    "author": {"type": "string", "example": "Frank Herbert"},
                    "year": {"type": "integer", "minimum": 1450, "maximum": 2100, "example": 1965},
                    "genre": {"type": "string", "enum": GENRES, "example": "fiction"},
                    "price": {"type": "number", "minimum": 0, "example": 9.99},
                },
            },
            "Order": {
                "type": "object",
                "required": ["id", "book_id", "quantity", "status"],
                "properties": {
                    "id": {"type": "string", "example": "ORD-1001"},
                    "book_id": {"type": "integer", "example": 1},
                    "quantity": {"type": "integer", "minimum": 1, "example": 2},
                    "status": {"type": "string", "enum": ["processing", "shipped"]},
                },
            },
        },
    },
    "paths": {
        "/health": {"get": {
            "tags": ["Reports"], "summary": "Check that the API is up", "operationId": "health",
            "responses": {"200": _response("The API is up.", {"type": "object", "required": ["status"], "properties": {"status": {"type": "string", "enum": ["ok"]}}})},
        }},
        "/auth/login": {"post": {
            "tags": ["Account"], "summary": "Sign in", "operationId": "login",
            "requestBody": {"required": True, "content": {"application/json": {"schema": {
                "type": "object",
                "required": ["email", "password"],
                "properties": {
                    "email": {"type": "string", "format": "email", "example": DEMO_EMAIL},
                    "password": {"type": "string", "example": DEMO_PASSWORD},
                },
            }}}},
            "responses": {
                "200": _response("Signed in.", {"type": "object", "required": ["access_token", "token_type"], "properties": {
                    "access_token": {"type": "string"}, "token_type": {"type": "string", "enum": ["bearer"]}, "expires_in": {"type": "integer"},
                }}),
                "401": _response("Wrong email or password.", ERROR),
                "422": _response("The body is not valid.", ERROR),
            },
        }},
        "/me": {"get": {
            "tags": ["Account"], "summary": "The signed-in reader", "operationId": "me", "security": AUTH,
            "responses": {
                "200": _response("The reader.", {"type": "object", "required": ["id", "email", "name"], "properties": {
                    "id": {"type": "integer"}, "email": {"type": "string", "format": "email"}, "name": {"type": "string"},
                }}),
                **SIGN_IN_PROBLEMS,
            },
        }},
        "/books": {
            "get": {
                "tags": ["Books"], "summary": "List books", "operationId": "listBooks",
                "parameters": [
                    {"name": "limit", "in": "query", "description": "How many books to return.", "schema": {"type": "integer", "minimum": 1, "maximum": 50, "default": 10}},
                    {"name": "genre", "in": "query", "description": "Only books of this genre.", "schema": {"type": "string", "enum": GENRES}},
                ],
                "responses": {"200": _response("The books.", {"type": "array", "items": BOOK}), "400": _response("A query value is not valid.", ERROR)},
            },
            "post": {
                "tags": ["Books"], "summary": "Add a book", "operationId": "createBook", "security": AUTH,
                "requestBody": BOOK_INPUT_BODY,
                "responses": {"201": _response("The book was added.", BOOK), **SIGN_IN_PROBLEMS, "422": _response("The book is not valid.", ERROR)},
            },
        },
        "/books/{bookId}": {
            "get": {
                "tags": ["Books"], "summary": "Find a book", "operationId": "getBook",
                "parameters": [{**BOOK_ID, "example": 1}],
                "responses": {"200": _response("The book.", BOOK), "400": _response("bookId is not a number.", ERROR), "404": _response("No such book.", ERROR)},
            },
            "put": {
                "tags": ["Books"], "summary": "Replace a book", "operationId": "updateBook", "security": AUTH,
                "parameters": [{**BOOK_ID, "example": 1}],
                "requestBody": BOOK_INPUT_BODY,
                "responses": {
                    "200": _response("The updated book.", BOOK), "400": _response("bookId is not a number.", ERROR), **SIGN_IN_PROBLEMS,
                    "404": _response("No such book.", ERROR), "422": _response("The book is not valid.", ERROR),
                },
            },
            "delete": {
                "tags": ["Books"], "summary": "Delete a book", "operationId": "deleteBook", "security": AUTH,
                "parameters": [{**BOOK_ID, "example": 2}],
                "responses": {"204": _response("The book was deleted."), "400": _response("bookId is not a number.", ERROR), **SIGN_IN_PROBLEMS, "403": _response("Another reader added this book.", ERROR), "404": _response("No such book.", ERROR)},
            },
        },
        "/orders": {"get": {
            "tags": ["Orders"], "summary": "List your orders", "operationId": "listOrders", "security": AUTH,
            "responses": {"200": _response("Your orders.", {"type": "array", "items": {"$ref": "#/components/schemas/Order"}}), **SIGN_IN_PROBLEMS},
        }},
        "/orders/{orderId}": {"get": {
            "tags": ["Orders"], "summary": "Find an order", "operationId": "getOrder", "security": AUTH,
            # No example on purpose: the contract quality report suggests one, and the value must be entered.
            "parameters": [{"name": "orderId", "in": "path", "required": True, "description": "An order id such as ORD-1001.", "schema": {"type": "string", "pattern": "^ORD-[0-9]{4}$"}}],
            "responses": {"200": _response("The order.", {"$ref": "#/components/schemas/Order"}), **SIGN_IN_PROBLEMS, "404": _response("No such order.", ERROR)},
        }},
        "/reports/sales": {"get": {
            "tags": ["Reports"], "summary": "Sales summary", "operationId": "salesReport",
            "responses": {"200": _response("The summary.", {"type": "object", "required": ["orders", "books_sold", "revenue"], "properties": {
                "orders": {"type": "integer"}, "books_sold": {"type": "integer"}, "revenue": {"type": "number"},
            }})},
        }},
    },
}
