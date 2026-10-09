# API QA Intelligence

[![CI](https://github.com/berkantepli/api-qa-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/berkantepli/api-qa-intelligence/actions/workflows/ci.yml)

An AI-powered API quality intelligence platform that turns an OpenAPI description into thoughtful, risk-aware tests, runs selected checks, and explains failures in a QA context.

This project is **not a Postman replacement**. Its focus is helping teams decide what to test, see meaningful coverage gaps, and understand what a failure may mean.

## Product flow

```text
OpenAPI / Swagger → API understanding → QA scenarios → selected test execution → failure analysis
```

## MVP scope

- Import an OpenAPI JSON or YAML file.
- Inspect operations, parameters, request bodies, and response schemas.
- Generate editable happy-path, negative, boundary, validation, and security-minded scenarios.
- Let a user select scenarios and execute them against an explicitly configured base URL.
- Show each result as **PASS**, **FAIL**, or **ERROR**, with request/response evidence in browser-local Run history.
- Explain failed checks with evidence from the test result; AI analysis is advisory and does not change the result.

## Technology

- **Backend:** Python, FastAPI, Pydantic
- **HTTP execution:** HTTPX
- **AI:** local Ollama adapter with a configurable model; additional providers can be added later
- **Frontend:** React with Vite, served by the backend from `frontend/dist`

The backend imports an OpenAPI 3.x or Swagger 2.0 JSON/YAML file or URL (Swagger 2.0 is converted to OpenAPI 3 on import: servers from host/basePath/schemes, body and formData parameters as request bodies, definitions and security definitions as components; the overview shows the original version) and returns a readable operation overview with deterministic baseline QA scenario suggestions and JSON request examples when it can safely derive them. It can execute one check or a selected batch, compare response statuses with expected codes, and record redacted request/response evidence in Run history. On request, Ollama can suggest extra review-only ideas for a selected endpoint or provide advisory analysis of a failed check; deterministic results remain authoritative.

## Repository layout

```text
.
├── backend/app/
│   ├── api/           # FastAPI routes: spec import, check execution, AI features
│   ├── domain/        # OpenAPI parsing, scenario generation, evidence redaction, target checks
│   ├── integrations/  # Ollama adapter
│   └── main.py
├── frontend/src/      # React interface
├── docs/MVP_ROADMAP.md
└── pyproject.toml
```

## Getting started

From the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --app-dir backend --reload --port 8001
```

The API QA Intelligence docs are available at `http://127.0.0.1:8001/docs`. Import a file with `POST /api/v1/specs/import` using the multipart field name `file`, or import your target API’s OpenAPI URL with `POST /api/v1/specs/import-url` and `{"url":"http://127.0.0.1:8000/openapi.json"}`. Both import methods return the API title, version, operations, and baseline scenario suggestions; importing a spec does not call its API operations.

### Web interface

Build the frontend once, then run the backend:

```bash
cd frontend
npm install
npm run build
cd ..
source .venv/bin/activate
uvicorn app.main:app --app-dir backend --reload --port 8001
```

Open `http://127.0.0.1:8001` for the API QA Intelligence interface and API. The backend serves the built frontend from `frontend/dist`.

To run one explicit check, use `POST /api/v1/runs/execute`. Provide a base URL (it may include the server’s base path, such as `https://petstore3.swagger.io/api/v3`; the operation path is appended to it), method, path, optional query parameters, headers or JSON body, expected status codes, and optionally the operation’s `response_schemas` from the API overview. For example:

```json
{
  "base_url": "http://127.0.0.1:8000",
  "method": "GET",
  "path": "/health",
  "expected_status_codes": [200]
}
```

A check passes when the response status is one of the expected codes. When `response_schemas` are given and the contract documents a JSON schema for the received status (an exact code, a range such as `4XX`, or `default`), the response body must also match it: types (including `nullable` and type lists), `enum`/`const`, required and documented properties, `additionalProperties: false`, array items, numeric and length bounds, and `allOf`/`anyOf`/`oneOf`. A mismatch turns the check into a FAIL with the differences listed by JSON path (for example `$[31].name: required property is missing`); `format` and `pattern` are not enforced. The body is not checked when the status already fails, the response is truncated, or no schema is documented. An optional `max_duration_ms` fails a check whose response took longer; in the overview it is the **Response time limit** below the target URL, saved per API. The UI sends these schemas automatically; APIs imported before 0.3.0 need to be imported again.

The topbar connection indicator asks the backend to probe the target base URL (`POST /api/v1/targets/check`): a read-only `HEAD` request, retried as `GET` when the server rejects `HEAD`, with the same safety rules as check execution. It shows *API reachable* (status code, method, and response time in its tooltip), or the code itself for problems such as *API error · 503*; it also explains connection failures and reports targets the safety rules do not allow.

Only call APIs you own or are authorized to test. Execution does not happen during import, and redirects are not followed.

For a selected set of checks, use `POST /api/v1/runs/execute-batch` with a `scenarios` array containing the same fields as the single-check request. The response includes a PASS/FAIL/ERROR summary and per-check request/response evidence. Sensitive header and body values are redacted, and uploaded file contents are not included in the evidence. Request inputs are prefilled from the contract’s `example`, `default`, or first `enum` value. **Fill with AI** fills the remaining empty body fields and query parameters on request (`POST /api/v1/specs/sample-values`): the model receives only field names, locations, descriptions, and schemas — never entered values, credentials, or the target URL — and every answer is checked against the field’s schema. AI-filled values are marked for review; if Ollama is unavailable, schema-based samples are used and labelled as such. Path parameters, headers, cookies, files, and credential-like fields are never generated; required ones are marked *Fill this in yourself* with the reason. Clearing an optional field leaves it out of the request. Credentials derived from an operation’s security requirement (for example an `Authorization` header or an API key) are shown as optional *credential* fields: fill them to call the API authenticated, or leave them empty to send the request without credentials. The *Call without authentication* check always leaves the documented credentials out, sends the otherwise valid request, and expects 401 or 403 (or the auth error codes the contract documents); when authentication is optional for an operation it stays a review idea. JSON examples are only generated when the contract provides enough information; path parameters and non-JSON request bodies still need a manual example.

Saved APIs can be deleted from the API specs page (trash icon, then confirm). Deleting removes the API’s contract, scenarios, edited AI checks, and saved request details; its Run history is kept.

### Duplicate scenarios

The API overview flags scenarios on the same endpoint that seem to test the same thing, so AI ideas do not pile up on top of contract checks. A pair is flagged when both send the same request and expect the same status, when both test the same idea (a missing required input, authentication, an invalid or boundary value, injection, or rate limiting) on the same field, or when their wording is very similar. Scenarios aimed at different fields are never flagged. Contract checks are kept; choose **Dismiss idea** / **Remove check** for the copy, or **Keep both** to stop flagging that pair.

### Run history

In the overview, **Select all** selects every runnable check of the endpoint, each endpoint in the list shows a green or red dot for its latest run, and the summary cards show how many endpoints are tested and how many checks can run with the request details entered so far. On the import page, **Try the Swagger Petstore sample** imports the public Petstore contract when you have no spec at hand.

Every executed batch is saved in Run history, grouped by API with pass/fail/error totals and the most recently used API first. Groups start collapsed; open one to see its runs. Open a run to see its target, PASS/FAIL/ERROR counts, and, for each check, the expected and received status, duration, the request line with headers and body, and the response status, headers, and body. Failed and errored checks open expanded. **Run again** opens the run's endpoint in the overview with the same checks selected, so you can enter any credentials again and rerun them. Delete a single run with the trash icon on its row, or every run for an API with the trash icon on the group header; both ask for confirmation and cannot be undone. Evidence is stored already redacted; uploaded file contents are never stored.

### Coverage & Risk

The **Coverage** page summarizes, for the active API, how many endpoints have been tested, which endpoints failed in their latest run, and which data-changing endpoints were never tested. Each endpoint shows its latest status, how many of its runnable checks were executed, and risk flags such as *Changes data, not tested*, *Only happy path tested*, *Auth not checked*, *Flaky results* (a check's outcome flipped at least twice in its last five results), or *Not run in 7+ days*. A strip under each endpoint shows which check categories (happy path, negative, boundary, invalid value, auth) passed, have failures, have not run, or have no runnable check. **Export Markdown** and **Export JSON** download the same summary as a shareable report; it contains no request or response evidence. Select an endpoint to open it in the overview.

**Run checks** runs the checks of every endpoint in the current filter, one at a time, against the active target URL. It first shows a plan: endpoints that are ready, endpoints that still need request details (for example a path parameter; choose **Open** to fill them in), and data-changing endpoints (POST, PUT, PATCH, DELETE), which are left out unless you turn on **Include data-changing endpoints**. Included ones run after the read-only checks, creates before updates and deletes last, and only after a second confirmation that names how many data-changing checks will be sent to which target. Choose **All runnable checks** or **Valid request only**. Progress can be stopped at any time, and each endpoint's results are saved to Run history as a separate run. Request details you enter are saved per API so later runs can reuse them; credential values are never stored and only live in the open tab.

### Settings and backups

### Where data is saved

Saved APIs (with edited AI checks), Run history, and request details are saved by the backend in a SQLite database: `data/workspace.db` in a source checkout, `~/.api-qa-intelligence/workspace.db` for an installed package, or the folder set in `API_QA_DATA_DIR` (`GET /api/v1/workspace` and the `PUT`/`DELETE` routes under it). They survive clearing the browser and are shared by every browser that opens the same backend. Credential values are never stored: the backend drops request details marked as credentials even if a client sends them. The database records its schema version and upgrades older files when the app starts.

The first time the app starts with an empty database, the saved APIs and runs from this browser's earlier storage move into it automatically; the browser keeps a copy only as a fallback. If the backend cannot be reached, the app keeps working with that browser copy and says so at the top of the page. To move data between machines, use **Export workspace** and **Import workspace**.

The **Settings** page shows whether the configured Ollama model is reachable and installed (`GET /api/v1/ai/status`), runs a step-by-step diagnosis — backend, Ollama server, required model, and a short inference test — with a suggested fix for any failing step (`GET /api/v1/ai/diagnose`; also started by clicking the AI status in the sidebar), exports the workspace as a JSON file, imports an export (APIs with the same id are replaced and existing runs are skipped), and can delete all saved data after confirmation.

### Optional AI features

Install and run Ollama with a model. The default model is `qwen3-vl:8b-instruct`, and the default Ollama URL is `http://127.0.0.1:11434`. Override them with `OLLAMA_MODEL` and `OLLAMA_BASE_URL` before starting the backend. In an API overview, choose **Suggest scenarios** to send the selected endpoint’s contract details (operation, parameters, and body field names/types) to the configured model. The model receives no example values, credentials, target URL, or API traffic. It also receives the titles of the endpoint’s existing checks and is asked not to repeat them; ideas that still repeat an existing check are skipped. On endpoints without parameters or a request body, ideas stay review notes because a check made from them would repeat the contract check. Suggestions are review-only and are not runnable until you choose **Convert to check**, state the expected status codes, and decide for each parameter whether to use the request details, omit it, send it with an empty value (not available for path parameters), or send a custom value; the editor warns when a draft would send exactly the same request as another check; JSON bodies are sent exactly as written in the editor. Saved checks are labeled **AI idea · edited**, stay in this browser with the saved API, and run only when you select them, with the usual confirmation for data-changing methods. In a run’s details, choose **Analyze with AI** on a failed check to send that check’s redacted evidence for optional, advisory analysis. Read the on-screen disclosure before requesting either AI feature.

## Running with Docker

The image contains the web app, the backend, and the `api-qa` CLI. Each release is published to GitHub Container Registry:

```bash
docker run -p 8001:8001 -v api-qa-data:/data ghcr.io/berkantepli/api-qa-intelligence
```

To build it yourself instead: `docker build -t api-qa-intelligence .`

Open http://localhost:8001. The workspace database lives in the `/data` volume, so it survives new containers. Inside the container `127.0.0.1` is the container itself: to test an API running on your machine, use `http://host.docker.internal:<port>` as the target and start the container with `-e API_QA_ALLOW_PRIVATE_NETWORK=1`, which allows private-network targets (off by default). AI features look for Ollama at `http://host.docker.internal:11434`; set `OLLAMA_BASE_URL` to change it. To open the app under another host name, add it to `API_QA_ALLOWED_HOSTS`. The CLI runs the same way: `docker run --rm api-qa-intelligence api-qa run --spec https://example.com/openapi.json`.

## Running checks in CI

The `api-qa` command runs a contract's runnable checks without the web app, so a CI pipeline can test an API on every change. It is installed with the backend (`pip install -e .`, or `pip install "git+https://github.com/berkantepli/api-qa-intelligence"`).

```bash
api-qa run --spec openapi.yaml --target https://staging.example.com \
  --header "Authorization: Bearer $API_TOKEN" --param petId=10 \
  --junit report.xml --json report.json
```

- **What runs:** the contract-based checks of every endpoint, with the response body checked against the documented schema. AI features are never used, so results are repeatable. `--smoke` runs only each endpoint's valid request; `--endpoint 'GET /pet/*'` narrows the endpoints.
- **Data-changing methods** (POST, PUT, PATCH, DELETE) are skipped unless you pass `--include-writes`.
- **Request inputs:** parameters fall back to the contract's examples. Give missing ones with `--param name=value` (or `path:name=value`), or put them in a JSON file passed with `--inputs`, keyed by `"METHOD /path"` (or `"*"` for all endpoints) with the web app's input keys, for example `{"GET /pet/{petId}": {"parameter:path:petId": "10"}}`. An endpoint whose required inputs are still missing is reported as skipped, with the missing names; `--fail-on-skipped` turns that into a failure.
- **Credentials:** pass them with `--header`. They are sent with every check except one that deliberately leaves them out (such as *Call without authentication*), and their values are replaced with `[REDACTED]` everywhere in the reports.
- **Target:** defaults to the contract's first server. Private-network hosts (for example a Docker service name) are blocked unless you pass `--allow-private-network`.
- **Reports:** `--junit` writes JUnit XML (one test suite per endpoint, one test case per check, skipped checks marked as skipped), which GitHub Actions, GitLab, and Jenkins display as test results; `--json` writes the full results with redacted evidence.
- **Response time:** `--max-duration-ms 1000` fails a check whose response takes longer than one second.
- **Exit codes:** `0` when every check passed, `1` when a check failed or errored (or was skipped, with `--fail-on-skipped`), `2` for a usage or contract problem.

A ready-to-copy GitHub Actions job is in [`docs/examples/github-actions-api-qa.yml`](docs/examples/github-actions-api-qa.yml).

## Running tests

```bash
source .venv/bin/activate
pytest
```

Frontend logic tests:

```bash
cd frontend
npm test
```

The backend tests replace outbound HTTP calls with an in-memory transport, so they never contact a target API or Ollama.

Browser tests (Playwright) walk the main flows — import, passing and failing checks, schema differences, a missing-key finding, data surviving a cleared browser, Run again, a bulk run with data-changing endpoints, and Delete all — against a small target API with deliberate problems ([`frontend/e2e/target_api.py`](frontend/e2e/target_api.py)). They start the app on a throwaway database:

```bash
cd frontend
npm run build
npm run test:e2e
```

Locally they use the installed Google Chrome; set `E2E_PYTHON` if the backend's Python is not `../.venv/bin/python`.

The same checks run on GitHub Actions for every pull request and push to `main` ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)): backend lint and tests, frontend tests and build, the browser tests, and a Docker image build with a smoke test.

## Backend API

Every feature of the web app goes through a documented HTTP API under `/api/v1`, which is stable for all 1.x releases: see [docs/API.md](docs/API.md), and `/docs` on a running backend for the typed reference.

## Roadmap

[docs/MVP_ROADMAP.md](docs/MVP_ROADMAP.md) records how the project was planned up to 1.0. Ideas after 1.0 include a built-in demo API, a hosted demo, and more AI providers than a local Ollama.

## Security and responsible use

- Run checks only against APIs you own or are authorized to test.
- Never commit credentials, API tokens, or private OpenAPI specifications.
- Configure the target host explicitly; generated scenarios should not silently send requests.
- Treat AI-generated scenarios and failure explanations as suggestions that need review.
- The backend has no login and is meant to run on your own machine. It answers only to `localhost` and `127.0.0.1`, which stops DNS rebinding (a web page re-pointed to 127.0.0.1 cannot read or delete the workspace or send checks through it). To reach it under another name, for example in a container, list the names in `API_QA_ALLOWED_HOSTS` (comma-separated, or `*`); do not expose it to a network you do not trust.
- Checks only reach public hosts or this machine (private-network hosts are refused unless the CLI is given `--allow-private-network`), never follow redirects, and send nothing unless you start a run.
- Credentials are kept only in the open tab: run evidence, exports, the workspace database, and CLI reports redact them.
- Importing a contract cannot hang the app: `$ref` chains are expanded only up to a fixed size, beyond which schemas accept any value.

## Project status

Stable (1.0). The app imports OpenAPI 3.x and Swagger 2.0 contracts, generates contract-based checks, runs them from the browser, in bulk, or from CI with JUnit and JSON reports, checks responses against the documented schema and an optional time limit, keeps redacted evidence and the workspace in a local database, summarizes coverage and risk, and optionally uses a local Ollama model for scenario ideas, sample values, and failure analysis.

Within 1.x, the `/api/v1` HTTP API, the `api-qa` command line, the workspace database, and workspace export files stay compatible: new features are added, existing behavior is not removed. Older databases are upgraded when the app starts.

The current version is in [`VERSION`](VERSION) (shown in the sidebar and returned by `GET /health`); see [CHANGELOG.md](CHANGELOG.md) for what changed in each release.

## License

Released under the [MIT License](LICENSE). © 2026 Berk Antepli
