import json
import re
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SENSITIVE_KEY = re.compile(
    r"authorization|authentication|(?:^|[^a-z])auth(?:$|[^a-z])|cookie|token|secret|"
    r"password|credential|api[-_]?key|(?:^|[^a-z])key(?:$|[^a-z])",
    re.IGNORECASE,
)


def redact_value(value: Any) -> Any:
    if isinstance(value, dict):
        return {
            key: "[REDACTED]" if SENSITIVE_KEY.search(str(key)) else redact_value(item)
            for key, item in value.items()
        }
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    return value


def redact_headers(headers: dict[str, Any]) -> dict[str, str]:
    return {
        name: "[REDACTED]" if SENSITIVE_KEY.search(name) else str(value)
        for name, value in headers.items()
    }


def sanitize_url(url: str) -> str:
    parts = urlsplit(url)
    host = parts.hostname or ""
    try:
        port = parts.port
    except ValueError:
        return ""
    if ":" in host and not host.startswith("["):
        host = f"[{host}]"
    netloc = f"{host}:{port}" if port else host
    query = [
        (key, "[REDACTED]" if SENSITIVE_KEY.search(key) else value)
        for key, value in parse_qsl(parts.query, keep_blank_values=True)
    ]
    return urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), ""))


def redact_text(value: str) -> str:
    try:
        parsed = json.loads(value)
        return json.dumps(redact_value(parsed), ensure_ascii=False, indent=2)
    except json.JSONDecodeError:
        pattern = re.compile(
            r"((?:authorization|authentication|auth|cookie|token|secret|password|credential|api[-_]?key|\bkey)"
            r"[\"']?\s*[:=]\s*)(?:\"[^\"]*\"|'[^']*'|[^\s,;}]+)",
            re.IGNORECASE,
        )
        return pattern.sub(r'\1"[REDACTED]"', value)
