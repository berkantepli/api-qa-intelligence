# Backend API (v1)

The web app talks to the backend only through these HTTP endpoints, and you can call them yourself. The live, typed reference is the OpenAPI document the backend serves at `/docs` (Swagger UI) and `/openapi.json`.

## Stability promise

From 1.0.0, everything listed here is stable for all 1.x releases:

- Routes are not removed or renamed, and their methods do not change.
- Request and response fields are not removed or renamed, and their meaning does not change.
- New routes, new optional request fields, and new response fields may be added in a minor release, so clients should ignore fields they do not know.

A change that breaks these rules waits for 2.0 (or a new `/api/v2` prefix). `backend/tests/test_api_contract.py` fails if a listed route or field disappears.

The backend has no login and is meant to run on your own machine; it answers only to `localhost` and `127.0.0.1` unless `API_QA_ALLOWED_HOSTS` lists more names.

## Endpoints

### Health

| Method | Path | Purpose |
|---|---|---|
| GET | `/health` | `{"status": "ok", "version": "<app version>"}` |

### Contracts

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/specs/import` | Import an OpenAPI 3.x or Swagger 2.0 file (multipart `file`, at most 2 MB). Returns the API overview: operations, parameters, body fields, response schemas, and contract-based scenarios. |
| POST | `/api/v1/specs/import-url` | Same, from `{"url": "..."}` (public hosts or this machine). |
| POST | `/api/v1/specs/scenario-ideas` | Ask the configured Ollama model for review-only scenario ideas for one operation. |
| POST | `/api/v1/specs/sample-values` | Suggest schema-valid sample values for empty request inputs (Ollama, with schema-based fallback). |
| POST | `/api/v1/specs/diff` | Compare two API overviews (`base`, the earlier version, and `head`) and classify every change as breaking, warning, or safe, with the checks to run again per endpoint. `api-qa diff` uses the same comparison. |
| POST | `/api/v1/specs/quality` | Score how testable an API overview is (0–100, grade, rule scores, findings, top fixes, and a Markdown report). Imports already return it as the overview's `quality`. |
| POST | `/api/v1/requests/parse` | Read the requests of a Postman collection or HAR file (multipart `file`, at most 15 MB): method, path, query, and JSON or form body. Headers, auth, and cookies are never read; credential-like values are left out and counted. Nothing is stored. |

### Running checks

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/results/parse` | Read a Newman JSON report or JUnit XML (multipart field `file`, at most 5 MB) into test cases with their method, path, response status, outcome, and redacted failure message where the report records them. Nothing is stored; the web app matches the cases to endpoints. |
| POST | `/api/v1/runs/execute` | Send one check's request to a target and judge it: expected status codes, the documented response schema (`response_schemas`), and an optional time limit (`max_duration_ms`). Returns PASS / FAIL / ERROR with redacted request and response evidence. |
| POST | `/api/v1/runs/execute-batch` | The same for up to 20 checks, with totals. |
| POST | `/api/v1/runs/analyze-failure` | Ask the configured Ollama model to explain a failed check from its redacted evidence (advisory; it never changes the result). |
| POST | `/api/v1/targets/check` | Probe whether a target base URL responds (read-only `HEAD`, retried as `GET`). |

### Flows

A flow is a multi-step check that follows one record through its lifecycle: create it, read it back, update it, delete it, and confirm it is gone. A step saves values from its response (or the body it sent) with `extract` rules — a variable name and a JSON Pointer such as `/id` — and later steps use them as `{{variable}}` in the path, query and header values, and JSON body strings (a body string that is only a placeholder keeps the value's type, so `"{{petId}}"` sends the number `7`).

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/v1/flows/suggest` | Suggest flows for a list of operations from an API overview. Imports already return them as the overview's `flows`; this route serves APIs saved before 1.1. |
| POST | `/api/v1/flows/execute` | Run up to 10 steps in order against `base_url`, with shared `headers` and an optional `max_duration_ms`. Each step is judged like a single check. After a step fails, later steps are `SKIPPED`, except cleanup steps (`always_run`) whose values were saved. Returns PASS / FAIL / ERROR with per-step evidence. |

A step's `extract` rule may set `"fallback": "location_header"`: when the response body has no value at its pointer, the last path segment of the `Location` header is saved instead. Suggestions come from the contract: an OpenAPI `link` from a collection's POST response to the item path's GET or DELETE names the value to pass on; without one, the item path's parameter (`{petId}`) is matched to a field of the create response (`petId`, or `id` for an id-like parameter) or of the request body. Values saved under sensitive names (such as `token`) are redacted in `saved_values` and wherever they appear in later steps' evidence.

### AI model

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/ai/status` | Whether Ollama is reachable and the configured model is installed. |
| GET | `/api/v1/ai/diagnose` | A step-by-step diagnosis with a suggested fix for any failing step. |

### Workspace

Saved APIs, Run history, and request details are stored as the JSON documents the web app uses. Credential values are never stored.

| Method | Path | Purpose |
|---|---|---|
| GET | `/api/v1/workspace` | `{"savedApis": [...], "runHistory": [...], "requestInputs": {...}}` |
| PUT | `/api/v1/workspace/apis/{api_id}?position=N` | Save one saved API (its `id` must match the path). |
| DELETE | `/api/v1/workspace/apis/{api_id}` | Delete a saved API and its request details. |
| PUT | `/api/v1/workspace/runs/{run_id}` | Save one run. |
| DELETE | `/api/v1/workspace/runs/{run_id}` | Delete one run. |
| PUT | `/api/v1/workspace/inputs/{api_id}` | Save request details for an API, keyed by `"METHOD /path"`; credential fields are dropped. |
| DELETE | `/api/v1/workspace` | Delete everything saved. |

Each record must be smaller than 5 MB. The database records its schema version and upgrades older files on start; a database from a newer version is refused rather than overwritten.

## Command line

`api-qa run` (see the README) uses the same check engine without the HTTP API. Its options, exit codes (`0` all passed, `1` a check failed, `2` usage problem), and report formats (JUnit XML, JSON) follow the same stability promise.
