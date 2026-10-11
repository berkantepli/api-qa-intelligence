"""Reads a JSON or YAML contract with limits, so a small hostile file cannot exhaust the app.

YAML anchors and aliases let a 1 KB file describe billions of values ("billion laughs"); they are
cheap to parse but explode when the document is walked or serialized. The document is therefore
walked once after parsing, counting every value each time it is reached, and refused past a limit.
"""

import json
from typing import Any

import yaml

# A 2 MB contract has a few hundred thousand values; aliases that expand beyond this are an attack.
MAX_DOCUMENT_VALUES = 1_000_000
MAX_DOCUMENT_DEPTH = 100


class DocumentTooComplexError(ValueError):
    pass


TOO_COMPLEX = (
    "The document is too large or too deeply nested to read once YAML anchors and aliases are expanded "
    f"(at most {MAX_DOCUMENT_VALUES:,} values and {MAX_DOCUMENT_DEPTH} levels)."
)

UNEXPECTED_SHAPE = (
    "Part of this OpenAPI document has an unexpected shape (for example a list where an object belongs), "
    "so it could not be read. Check the document with an OpenAPI validator."
)


def parse_document(text: str, *, as_json: bool) -> Any:
    """Parses JSON or YAML; raises json.JSONDecodeError, yaml.YAMLError, or DocumentTooComplexError."""
    try:
        document = json.loads(text) if as_json else yaml.safe_load(text)
    except RecursionError as error:
        raise DocumentTooComplexError(TOO_COMPLEX) from error
    check_document_size(document)
    return document


def check_document_size(document: Any) -> None:
    budget = MAX_DOCUMENT_VALUES
    stack = [(document, 0)]
    while stack:
        node, depth = stack.pop()
        budget -= 1
        if budget < 0 or depth > MAX_DOCUMENT_DEPTH:
            raise DocumentTooComplexError(TOO_COMPLEX)
        if isinstance(node, dict):
            stack.extend((value, depth + 1) for value in node.values())
        elif isinstance(node, list):
            stack.extend((value, depth + 1) for value in node)
