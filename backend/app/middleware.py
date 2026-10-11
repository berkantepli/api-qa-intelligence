"""ASGI middleware that protects the app regardless of which route a request reaches."""

import json

from fastapi import HTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

# Larger than any legitimate request: a check with a few 10 MB file uploads (base64) fits.
MAX_REQUEST_BYTES = 32_000_000
TOO_LARGE = f"The request is too large; the limit is {MAX_REQUEST_BYTES // 1_000_000} MB."


class RequestSizeLimitMiddleware:
    """Refuses request bodies over the limit, by Content-Length up front or while a chunked body streams."""

    def __init__(self, app: ASGIApp, max_bytes: int = MAX_REQUEST_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        length = dict(scope["headers"]).get(b"content-length")
        if length is not None and length.isdigit() and int(length) > self.max_bytes:
            body = json.dumps({"detail": TOO_LARGE}).encode()
            await send({"type": "http.response.start", "status": 413, "headers": [
                (b"content-type", b"application/json"), (b"content-length", str(len(body)).encode()),
            ]})
            await send({"type": "http.response.body", "body": body})
            return

        received = 0

        async def limited_receive() -> Message:
            nonlocal received
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    # Raised while the route reads its body, so FastAPI answers with this status.
                    raise HTTPException(status_code=413, detail=TOO_LARGE)
            return message

        await self.app(scope, limited_receive, send)


# Stops other sites from framing the app (clickjacking: tricking a click on Delete everything or
# Confirm and run) and from sniffing content types. The CSP only restricts framing, so the API docs
# page can still load its assets.
SECURITY_HEADERS = [
    (b"x-frame-options", b"DENY"),
    (b"content-security-policy", b"frame-ancestors 'none'"),
    (b"x-content-type-options", b"nosniff"),
    (b"referrer-policy", b"no-referrer"),
]


class SecurityHeadersMiddleware:
    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_headers(message: Message) -> None:
            if message["type"] == "http.response.start":
                names = {name.lower() for name, _ in message.get("headers", [])}
                message["headers"] = [*message.get("headers", []), *(item for item in SECURITY_HEADERS if item[0] not in names)]
            await send(message)

        await self.app(scope, receive, send_with_headers)
