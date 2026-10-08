import json
from functools import lru_cache
from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Response, status

from app.domain.store import WorkspaceStore, default_database_path

router = APIRouter(prefix="/api/v1/workspace", tags=["Workspace"])
MAX_RECORD_BYTES = 5_000_000


@lru_cache
def get_store() -> WorkspaceStore:
    return WorkspaceStore(default_database_path())


def _check_size(record: Any) -> None:
    if len(json.dumps(record)) > MAX_RECORD_BYTES:
        raise HTTPException(status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE, detail="The record must be smaller than 5 MB.")


def _credential_keys(api: dict[str, Any] | None) -> set[str]:
    operations = (api or {}).get("overview", {}).get("operations", [])
    return {
        f"parameter:{parameter.get('location')}:{parameter.get('name')}"
        for operation in operations if isinstance(operation, dict)
        for parameter in operation.get("parameters", []) if isinstance(parameter, dict) and parameter.get("credential")
    }


@router.get("", summary="Load the saved workspace")
def load_workspace(store: WorkspaceStore = Depends(get_store)) -> dict[str, Any]:
    return store.load()


@router.put("/apis/{api_id:path}", status_code=status.HTTP_204_NO_CONTENT, summary="Save a saved API")
def save_api(api_id: str, position: int = 0, api: dict[str, Any] = Body(...), store: WorkspaceStore = Depends(get_store)) -> Response:
    if api.get("id") != api_id or not isinstance(api.get("overview"), dict):
        raise HTTPException(status_code=422, detail="The saved API must include its id and overview.")
    _check_size(api)
    store.save_api(api, position)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/apis/{api_id:path}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a saved API")
def delete_api(api_id: str, store: WorkspaceStore = Depends(get_store)) -> Response:
    store.delete_api(api_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Save a run")
def save_run(run_id: str, run: dict[str, Any] = Body(...), store: WorkspaceStore = Depends(get_store)) -> Response:
    if str(run.get("id")) != run_id or not isinstance(run.get("results"), list):
        raise HTTPException(status_code=422, detail="The run must include its id and results.")
    _check_size(run)
    store.save_run(run)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("/runs/{run_id}", status_code=status.HTTP_204_NO_CONTENT, summary="Delete a run")
def delete_run(run_id: str, store: WorkspaceStore = Depends(get_store)) -> Response:
    store.delete_run(run_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.put("/inputs/{api_id:path}", status_code=status.HTTP_204_NO_CONTENT, summary="Save request details for an API")
def save_inputs(
    api_id: str, inputs: dict[str, dict[str, Any]] = Body(...), store: WorkspaceStore = Depends(get_store)
) -> Response:
    # Credentials are never stored, even if a client sends them.
    credentials = _credential_keys(store.get_api(api_id))
    cleaned = {
        operation: {key: value for key, value in values.items() if key not in credentials}
        for operation, values in inputs.items()
    }
    _check_size(cleaned)
    store.save_inputs(api_id, {operation: values for operation, values in cleaned.items() if values})
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.delete("", status_code=status.HTTP_204_NO_CONTENT, summary="Delete every saved API, run, and request detail")
def clear_workspace(store: WorkspaceStore = Depends(get_store)) -> Response:
    store.clear()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
