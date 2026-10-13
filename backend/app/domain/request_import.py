"""Reads the requests in a Postman collection or a HAR file, so the web app can compare them with the
contract and reuse their values as request details.

Only what describes a request is kept: method, path, query parameters, and a JSON or form body.
Headers, auth settings, and cookies are never read. Query parameters, body fields, and collection
variables with credential-like names are left out, and so is any value that looks like a secret
(a bearer token, a JWT, or a card number); the result says how many were left out.
"""

import json
import re
from typing import Any, Literal
from urllib.parse import parse_qsl, unquote, urlsplit

from pydantic import BaseModel, Field

from app.domain.documents import DocumentTooComplexError, check_document_size
from app.domain.evidence import SENSITIVE_KEY, scrub_text

METHODS = {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"}
VARIABLE = re.compile(r"\{\{([^{}]+)\}\}")
STATIC_FILE = re.compile(r"\.(js|mjs|css|map|png|jpe?g|gif|svg|webp|ico|woff2?|ttf|html?)$", re.IGNORECASE)
MAX_REQUESTS = 2_000
# A collection variable is copied into every request that uses it, so a small file could expand to
# gigabytes; anything longer than these limits is left out.
MAX_PATH_CHARS = 2_000
MAX_VALUE_CHARS = 2_000
MAX_BODY_CHARS = 200_000


class RequestFileError(ValueError):
    pass


class ImportedRequest(BaseModel):
    name: str
    method: str
    # The URL path; a segment whose value is unknown (an unresolved variable) is written as {name}.
    path: str
    query: dict[str, str] = Field(default_factory=dict)
    json_body: Any = None
    form_fields: dict[str, str] = Field(default_factory=dict)


class RequestCollection(BaseModel):
    source: Literal["postman", "har"]
    name: str
    requests: list[ImportedRequest]
    # Credential-like values that were left out, and entries that are not API requests.
    left_out_secrets: int = 0
    skipped: int = 0


def parse_request_file(contents: bytes) -> RequestCollection:
    try:
        document = json.loads(contents.decode("utf-8-sig"))
        check_document_size(document)
    except (UnicodeDecodeError, json.JSONDecodeError, RecursionError, DocumentTooComplexError) as error:
        raise RequestFileError("The file is not JSON. Choose a Postman collection (v2.0 or v2.1) or a HAR file.") from error
    if not isinstance(document, dict):
        raise RequestFileError("Choose a Postman collection (v2.0 or v2.1) or a HAR file.")
    if isinstance(document.get("log"), dict) and isinstance(document["log"].get("entries"), list):
        return _Reader("har").har(document["log"])
    info = document.get("info")
    if isinstance(info, dict) and "collection" in str(info.get("schema", "")) and isinstance(document.get("item"), list):
        return _Reader("postman").postman(document)
    if isinstance(document.get("run"), dict):
        raise RequestFileError("This is a Newman report, not a collection. Import it with Import test results on Coverage & Risk.")
    raise RequestFileError("This JSON file is neither a Postman collection (v2.0 or v2.1) nor a HAR file.")


class _Reader:
    def __init__(self, source: Literal["postman", "har"]) -> None:
        self.source = source
        self.left_out = 0
        self.skipped = 0
        self.requests: list[ImportedRequest] = []
        self.seen: set[str] = set()

    # --- Values ---------------------------------------------------------------------------------

    def keep(self, name: str, value: Any) -> bool:
        """False, and counted, for a credential-like name or a value that looks like a secret."""
        if SENSITIVE_KEY.search(str(name)) or (isinstance(value, str) and scrub_text(value) != value):
            self.left_out += 1
            return False
        return True

    def json_body(self, text: str | None) -> Any:
        """A JSON body, or None when it is not JSON, too long, or nested too deeply to read."""
        if text is None or len(text) > MAX_BODY_CHARS:
            return None
        try:
            document = json.loads(text)
            check_document_size(document)
        except (json.JSONDecodeError, RecursionError, DocumentTooComplexError):
            return None
        return self.clean_body(document)

    def clean_path(self, path: str | None) -> str | None:
        """None for a path that is too long; a segment that looks like a secret (a JWT, a bearer token,
        a card number) becomes {value} and is counted as left out."""
        if path is None or len(path) > MAX_PATH_CHARS:
            return None
        segments = []
        for segment in path.split("/"):
            if segment and scrub_text(segment) != segment:
                self.left_out += 1
                segment = "{value}"
            segments.append(segment)
        return "/".join(segments)

    def clean_body(self, value: Any) -> Any:
        if isinstance(value, dict):
            return {key: self.clean_body(item) for key, item in value.items() if self.keep(key, item)}
        if isinstance(value, list):
            return [self.clean_body(item) for item in value]
        if isinstance(value, str) and scrub_text(value) != value:
            self.left_out += 1
            return None
        return value

    def add(self, request: ImportedRequest) -> None:
        key = json.dumps([request.method, request.path, request.query, request.json_body, request.form_fields], sort_keys=True, default=str)
        if key not in self.seen and len(self.requests) < MAX_REQUESTS:
            self.seen.add(key)
            self.requests.append(request)

    def result(self, name: str) -> RequestCollection:
        return RequestCollection(source=self.source, name=name, requests=self.requests, left_out_secrets=self.left_out, skipped=self.skipped)

    # --- Postman --------------------------------------------------------------------------------

    def postman(self, document: dict[str, Any]) -> RequestCollection:
        variables = {
            str(item.get("key")): str(item.get("value"))
            for item in document.get("variable") or []
            if isinstance(item, dict) and item.get("key") and item.get("value") is not None and self.keep(item["key"], item["value"])
        }
        self.walk(document["item"], variables)
        return self.result(str((document.get("info") or {}).get("name") or "Postman collection"))

    def walk(self, items: list[Any], variables: dict[str, str]) -> None:
        for item in items:
            if not isinstance(item, dict):
                continue
            if isinstance(item.get("item"), list):
                self.walk(item["item"], variables)
            elif "request" in item:
                self.postman_request(str(item.get("name") or ""), item["request"], variables)

    def postman_request(self, name: str, request: Any, variables: dict[str, str]) -> None:
        if isinstance(request, str):
            request = {"method": "GET", "url": request}
        if not isinstance(request, dict):
            self.skipped += 1
            return
        method = str(request.get("method") or "GET").upper()
        url = request.get("url")
        path, query = self.postman_url(url, variables)
        path = self.clean_path(path)
        if method not in METHODS or path is None:
            self.skipped += 1
            return
        json_body, form = self.postman_body(request.get("body"), variables)
        self.add(ImportedRequest(name=name or f"{method} {path}", method=method, path=path, query=query, json_body=json_body, form_fields=form))

    def substitute(self, text: str, variables: dict[str, str], limit: int = MAX_VALUE_CHARS) -> str | None:
        """The text with {{variables}} filled in, or None when the result would be longer than `limit`
        (checked before building it)."""
        length = len(text)
        for match in VARIABLE.finditer(text):
            value = variables.get(match.group(1).strip())
            if value is not None:
                length += len(value) - len(match.group(0))
        if length > limit:
            return None
        return VARIABLE.sub(lambda match: variables.get(match.group(1).strip(), match.group(0)), text)

    def postman_url(self, url: Any, variables: dict[str, str]) -> tuple[str | None, dict[str, str]]:
        path_values: dict[str, str] = {}
        query: dict[str, str] = {}
        if isinstance(url, dict):
            for item in url.get("variable") or []:
                if isinstance(item, dict) and item.get("key") and item.get("value") not in (None, "") and self.keep(item["key"], item["value"]):
                    value = self.substitute(str(item["value"]), variables)
                    if value is not None:
                        path_values[str(item["key"])] = value
            for item in url.get("query") or []:
                if isinstance(item, dict) and item.get("key") and not item.get("disabled"):
                    value = self.substitute(str(item.get("value") or ""), variables)
                    if value is not None and self.keep(item["key"], value) and not VARIABLE.search(value):
                        query[str(item["key"])] = value
            segments = url.get("path")
            if isinstance(segments, list):
                raw_path = "/" + "/".join(str(segment) for segment in segments)
            elif isinstance(url.get("raw"), str):
                raw_path = self.raw_path(url["raw"], variables, query)
                if raw_path is None:
                    return None, {}
            else:
                return None, {}
        elif isinstance(url, str):
            raw_path = self.raw_path(url, variables, query)
            if raw_path is None:
                return None, {}
        else:
            return None, {}
        parts = []
        if len(raw_path) > MAX_PATH_CHARS:
            return None, {}
        for segment in raw_path.split("/"):
            segment = self.substitute(segment, variables, MAX_PATH_CHARS)
            if segment is None:
                return None, {}
            if not segment:
                continue
            if segment.startswith(":"):
                key = segment[1:]
                segment = path_values.get(key) or f"{{{key}}}"
            match = VARIABLE.fullmatch(segment)
            # An unresolved {{petId}} stands for a value the file does not have.
            parts.append(f"{{{match.group(1).strip()}}}" if match else segment)
        return "/" + "/".join(parts), query

    def raw_path(self, raw: str, variables: dict[str, str], query: dict[str, str]) -> str | None:
        """The path of a raw URL such as {{baseUrl}}/pets/1?x=1, filling `query` when it is empty;
        None when the URL is too long once its variables are filled in."""
        resolved = self.substitute(raw.strip(), variables, MAX_PATH_CHARS + MAX_VALUE_CHARS)
        if resolved is None:
            return None
        # A base URL variable that stays unresolved stands in front of the path.
        resolved = re.sub(r"^\{\{[^{}]*\}\}", "", resolved)
        parts = urlsplit(resolved if "://" in resolved else f"http://host{resolved if resolved.startswith('/') else '/' + resolved}")
        if not query:
            for key, value in parse_qsl(parts.query, keep_blank_values=True):
                if self.keep(key, value) and not VARIABLE.search(value):
                    query[key] = value
        return unquote(parts.path)

    def postman_body(self, body: Any, variables: dict[str, str]) -> tuple[Any, dict[str, str]]:
        if not isinstance(body, dict) or body.get("disabled"):
            return None, {}
        mode = body.get("mode")
        if mode == "raw" and isinstance(body.get("raw"), str) and body["raw"].strip():
            return self.json_body(self.substitute(body["raw"], variables, MAX_BODY_CHARS)), {}
        if mode in {"urlencoded", "formdata"}:
            form = {}
            for item in body.get(mode) or []:
                if not isinstance(item, dict) or item.get("disabled") or item.get("type") == "file" or not item.get("key"):
                    continue
                value = self.substitute(str(item.get("value") or ""), variables)
                if value is not None and self.keep(item["key"], value) and not VARIABLE.search(value):
                    form[str(item["key"])] = value
            return None, form
        return None, {}

    # --- HAR ------------------------------------------------------------------------------------

    def har(self, log: dict[str, Any]) -> RequestCollection:
        for entry in log["entries"]:
            request = entry.get("request") if isinstance(entry, dict) else None
            if not isinstance(request, dict) or not isinstance(request.get("url"), str):
                self.skipped += 1
                continue
            # Browsers mark what each request was for; only API calls (fetch, XHR) are kept.
            resource = entry.get("_resourceType")
            path = self.clean_path(unquote(urlsplit(request["url"]).path) or "/")
            method = str(request.get("method") or "GET").upper()
            if path is None or (isinstance(resource, str) and resource.lower() not in {"xhr", "fetch"}) or STATIC_FILE.search(path) or method not in METHODS:
                self.skipped += 1
                continue
            query = {
                str(item["name"]): str(item.get("value", ""))
                for item in request.get("queryString") or []
                if isinstance(item, dict) and item.get("name") and len(str(item.get("value", ""))) <= MAX_VALUE_CHARS
                and self.keep(item["name"], str(item.get("value", "")))
            }
            json_body, form = None, {}
            post = request.get("postData") if isinstance(request.get("postData"), dict) else {}
            mime = str(post.get("mimeType") or "").lower()
            if "json" in mime and isinstance(post.get("text"), str):
                json_body = self.json_body(post["text"])
            elif isinstance(post.get("params"), list):
                form = {
                    str(item["name"]): str(item.get("value", ""))
                    for item in post["params"]
                    if isinstance(item, dict) and item.get("name") and "fileName" not in item
                    and len(str(item.get("value", ""))) <= MAX_VALUE_CHARS and self.keep(item["name"], str(item.get("value", "")))
                }
            self.add(ImportedRequest(name=f"{method} {path}", method=method, path=path, query=query, json_body=json_body, form_fields=form))
        creator = log.get("creator") if isinstance(log.get("creator"), dict) else {}
        return self.result(f"HAR from {creator.get('name')}" if creator.get("name") else "HAR file")
