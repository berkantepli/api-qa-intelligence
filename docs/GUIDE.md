# API QA Intelligence: full guide

Everything the app does, in detail. For a short introduction and the quick start, see the [README](../README.md).

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
  Contract checks send a valid request, leave out a required input, try documented limits, formats, and enum values, send text where a number, boolean, array, or object is expected, send an extra field when the schema forbids one (`additionalProperties: false`), and call a protected endpoint without its credentials.
- Let a user select scenarios and execute them against an explicitly configured base URL.
- Show each result as **PASS**, **FAIL**, or **ERROR**, with redacted request/response evidence in Run history.
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

The quickest way to try it is the Docker image, with nothing else to install:

```bash
docker run -p 8001:8001 -v api-qa-data:/data ghcr.io/berkantepli/api-qa-intelligence
```

Open http://localhost:8001 and import a contract, or choose **Try the demo API** on the import page (see [Demo API](#demo-api)). Everything except the optional AI features works without further setup; see [Running with Docker](#running-with-docker) for testing an API on your own machine, and [Optional AI features](#optional-ai-features) for Ollama.

To run from source instead, from the repository root:

```bash
python -m venv .venv
source .venv/bin/activate
pip install -e ".[dev]"
uvicorn app.main:app --app-dir backend --reload --reload-dir backend --port 8001
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
uvicorn app.main:app --app-dir backend --reload --reload-dir backend --port 8001
```

Open `http://127.0.0.1:8001` for the API QA Intelligence interface and API. The backend serves the built frontend from `frontend/dist`. `--reload-dir backend` restarts the server only when backend code changes; without it, the server also restarts for frontend files and for other git worktrees inside the repository. After pulling a new version, run `npm run build` again for the interface and restart the server so `/health` and the API docs report the new version.

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

### Demo API

**Try the demo API** (on the import page and the empty API list) imports *Demo Bookstore*, a small API the backend serves itself under `/demo`, so it works offline and in Docker. Its contract is `/demo/openapi.json`; `GET /api/v1/demo` says where the backend reaches it. Sign in with `demo@example.com` / `demo-password` (the sign-in request in **Target & auth** is prefilled).

It has deliberate problems, and a **Demo tour** on its overview links each one to where it shows up:

- `GET /books` lists a book whose price is text, so the schema check fails.
- `GET /orders` documents a bearer token but answers without one, so *Call without authentication* fails.
- `POST` and `PUT /books/{bookId}` accept a year that is not a number and a field the schema forbids, and reject 1450, the documented minimum.
- `GET /reports/sales` takes about 1.5 seconds, so a response time limit of 1000 ms fails it.

Everything else behaves as documented, including the *Book lifecycle* flow. Its data lives in memory; **Reset demo data** in the tour (or `POST /demo/__reset`) brings back the three sample books. From the command line, with the app running: `api-qa run --spec http://127.0.0.1:8001/demo/openapi.json --include-writes --header "Authorization: Bearer <token>"`.

### Target and authentication

**Target & auth** in the topbar holds, for the active API, the target base URL, the response time limit, and its credentials. Every check, bulk run, and flow uses them; the endpoint panel shows a one-line summary with **Change**.

The credentials are the ones the contract documents (security schemes such as an API key header or `Authorization`), each listed once with the number of endpoints that use it. A value entered there is sent by every endpoint that needs it; a value entered in one endpoint's request details takes precedence for that endpoint, and *Call without authentication* still leaves it out. **Get a token from a sign-in request** sends one request to a sign-in endpoint of the contract (a likely one such as `POST /login` is offered first; the body is prefilled from the contract and never saved) and puts the token from its JSON response into the credential, adding `Bearer` for `Authorization`. The token is found at the usual places (`/access_token`, `/token`, `/data/token`, …) or at a JSON Pointer you give.

Credentials stay in the open tab's memory and are never saved to the workspace, run evidence, or exports. **Remember in this tab until it is closed** keeps them in the tab's session storage, so a reload does not clear them.

### Advanced view

Coverage & Risk and the overview start simple. **Advanced view** (on Coverage & Risk, or in Settings) adds the risk score and its rules, each endpoint's criticality, Trends, **Add CI test results**, and the duplicate hints described below. The choice is remembered in this browser.

### Duplicate scenarios

In the advanced view, the API overview flags scenarios on the same endpoint that seem to test the same thing, so AI ideas do not pile up on top of contract checks. A pair is flagged when both send the same request and expect the same status, when both test the same idea (a missing required input, authentication, an invalid or boundary value, injection, or rate limiting) on the same field, or when their wording is very similar. Scenarios aimed at different fields are never flagged. Contract checks are kept; choose **Dismiss idea** / **Remove check** for the copy, or **Keep both** to stop flagging that pair.

### Run history

In the overview, **Select all** selects every runnable check of the endpoint, each endpoint in the list shows a green or red dot for its latest run, and the summary cards show how many endpoints are tested and how many checks can run with the request details entered so far. When you have no spec at hand, the import page offers four public APIs to try: **Swagger Petstore** (the classic example), **FakeRESTApi** (full CRUD whose writes are not kept, so flows are safe to run), **Toolshop** (a QA practice shop API with login and roles), and **PokéAPI** (a large read-only API). Each imports with its target URL filled in.

Every executed batch is saved in Run history, grouped by API with pass/fail/error totals and the most recently used API first. Groups start collapsed; open one to see its runs. Open a run to see its target, PASS/FAIL/ERROR counts, and, for each check, the expected and received status, duration, the request line with headers and body, and the response status, headers, and body. Failed and errored checks open expanded. **Run again** opens the run's endpoint in the overview with the same checks selected, so you can enter any credentials again and rerun them. Delete a single run with the trash icon on its row, or every run for an API with the trash icon on the group header; both ask for confirmation and cannot be undone. Evidence is stored already redacted; uploaded file contents are never stored.

Each check (and each flow step) with a JSON response is compared with the last time the same check passed with the same status code. **Response changed since the last pass** lists fields that disappeared or are new, fields whose type changed (for example a number that is now a string, or a value that is now `null`), and lists that became empty. Values are not compared, so ids, timestamps, and prices that change on every call raise nothing; the keys of objects the contract documents as a map (`additionalProperties`) are not compared either, only their values' types. Truncated bodies are skipped. A change never fails the check, since it can be intended. The overview shows it under the check right after it runs, run details tag the check *Response changed*, and on Coverage & Risk an endpoint shows it too when the latest run that called it changed, whether that was one of its own checks or a flow step, with the changes on hover.

### Coverage & Risk

The **Coverage** page summarizes, for the active API, how many endpoints have been tested, which endpoints failed in their latest run, and which data-changing endpoints were never tested. Each endpoint shows its latest status, how many of its runnable checks were executed, and (with risk points in the [advanced view](#advanced-view)) risk flags such as *Changes data, not tested*, *Only happy path tested*, *Auth not checked*, *Flaky results* (a check's outcome flipped at least twice in its last five results), or *Not run in 7+ days*. A strip under each endpoint shows which check categories (happy path, negative, boundary, invalid value, auth) passed, have failures, have not run, or have no runnable check. Each endpoint also gets a **risk score** from 0 to 100 (high from 50, medium from 25), and endpoints are listed highest risk first. The score is the sum of fixed rules, and every rule that added points is shown next to it, for example *+20 Deletes data*, *+10 Sensitive area: orders*, or *+35 Failing in latest run*. Impact rules come from the contract (deletes or changes data, requires authentication, and a sensitive area: a path, summary, tag, or operation id naming accounts, users, orders, payments, or access control, or inputs such as a password or card number); evidence rules come from Run history (failing, flaky, never tested, auth not checked, only happy path tested, checks not run yet, not run in 7+ days). Each endpoint's **Criticality** select overrides the sensitive-area guess: **Critical** adds +20 *Marked critical* instead, and **Not critical** drops *Sensitive area*; the marks are saved with the API and kept on re-import. **How the risk score works** lists every rule and its points; no AI is involved, so the same history always gives the same score. Below each endpoint, **coverage gaps** list what its checks do not cover yet, in plain sentences such as *No invalid-value check for path parameter id* or *HTTP 404 is documented, but no check expects it*. For every input (parameters other than credentials, and body fields other than files), the contract decides which checks apply: leaving out a required query, header, or body input; boundary values when it documents limits such as `minimum` or `maxLength`; and an invalid value for path parameters, numbers, booleans, and inputs with a `format`, `pattern`, or `enum`. Each one is shown as passed, failing, not run, idea only (an AI idea not yet converted), or no check. Every documented response code is shown as received in a run, never received, or not expected by any check. A runnable check counts for an input by what its request does compared with the valid request (it leaves the input out or sends another value), and its category decides the kind. AI ideas and imported tests have no request here, so they count when their title or rationale names the input; short, common names such as `id` need a clear form such as `{id}`, "id parameter", or "invalid id". No AI is involved. The **Has gaps** filter lists the endpoints with gaps, and both reports include them. APIs imported before 1.2.0 list only response codes that have a JSON body until they are imported again. When you import a saved API again from the same URL or file name, the app compares the two contracts, even if the contract's title changed (the saved API keeps its runs and is renamed). If a new import has the same title as a saved API from another source, the overview offers **Merge into it** for a new version of that API, or **Keep separate** for a separate copy such as staging and production. The overview says how many endpoints are new, changed, or removed, and **Contract changes** on the Coverage page lists them with what changed, for example *New required body field tag*, *parameter id (path) is now required*, *Response 404 was removed*, or *Response 200 body schema changed*. Each change is also classified for clients as **Breaking**, **Warning**, or **Safe** (the same rules as [`api-qa diff`](#comparing-contract-versions)), with the checks worth running again per endpoint; **Copy as Markdown** copies the report, for example for a pull request. A changed endpoint adds +15 to its risk score (*Changed in the contract*) until it runs again; a new endpoint has never run, so it is scored once, as *Never tested*. The **Changed** filter lists new and changed endpoints that have not run since. Saved AI checks that no longer fit the contract (they send or leave out a parameter or body field the contract no longer has, send a body the endpoint no longer takes, or expect an undocumented status code) are marked *Review against the current contract* on their card and listed under Contract changes. Importing again keeps your edited AI checks and AI ideas on endpoints that still exist, your target URL, and your response time limit; Flows are suggested again from the new contract. **Export Markdown** and **Export JSON** download the same summary, including each risk score and its reasons, as a shareable report; it contains no request or response evidence. Select an endpoint to open it in the overview.

**Run checks** runs the checks of every endpoint in the current filter, one at a time, against the active target URL. It first shows a plan: endpoints that are ready, endpoints that still need request details (for example a path parameter; choose **Open** to fill them in), and data-changing endpoints (POST, PUT, PATCH, DELETE), which are left out unless you turn on **Include data-changing endpoints**. Included ones run after the read-only checks, creates before updates and deletes last, and only after a second confirmation that names how many data-changing checks will be sent to which target. Choose **All runnable checks** or **Valid request only**. Progress can be stopped at any time, and each endpoint's results are saved to Run history as a separate run. Request details you enter are saved per API so later runs can reuse them; credential values are never stored and only live in the open tab.

**Trends** on the Coverage page (advanced view) show, per day, the pass rate and the median and 95th-percentile response time of every check and flow step in Run history, over the last 7, 30, or 90 days, for the whole API or one endpoint. Each figure is compared with the same number of days before it. Days without checks are left empty instead of being filled in; hover a day for its numbers, or open **Show as table**. Imported Newman and JUnit results count too; those without a duration count only toward the pass rate. A third chart shows **Endpoints tested** over time: the share of the contract's endpoints that had run at least once by each day. When the API has a response time limit, the response time chart draws it as a dashed line. **Slowed down** lists the endpoints whose median response time in the range grew by at least 50% (and 50 ms) against their usual speed, the median of the 90 days before the range, for endpoints with 3 or more timed checks in both; a slowdown that started before the range and has not recovered still shows. Select one to see its trend. On the endpoint list, each tested endpoint shows a small line of its latest 12 runs' response times, with failed runs marked.

### Flows

The **Flows** page follows one record through its lifecycle across endpoints: create it, read it back, update it, delete it, and confirm it is gone. Flows are suggested from the contract when a collection's POST (`POST /pets`) creates records that an item path (`/pets/{petId}`) reads or deletes. The value passed from step to step comes from an OpenAPI `link` when the contract has one; otherwise the item path's parameter is matched to a field of the create response (`petId`, or `id` for an id-like parameter) or of the request body, and the flow says which.

Each step shows its request, the status it expects, and the value it saves for later steps (for example `{{petId}}`). **Run flow** asks for confirmation, because a flow creates and deletes data, and then runs the steps one at a time against the active target URL with its response time limit. Every step is judged like a single check, including the documented response schema. When a step fails, the remaining steps are skipped, except cleanup: the delete step still runs when the record was created, so test data does not pile up. A nested collection (`/owners/{ownerId}/pets`) first creates its parent with the parent's own flow and deletes it last. When the create response is not documented, the new record's id is read from an `id` field or, failing that, from the last part of the `Location` header. Other path parameters the flow cannot derive and credentials are entered on the flow; a credential typed in the overview for one of its endpoints is used too, and credentials stay only in the open tab. Each flow run is saved in Run history with per-step evidence. A flow step also counts as a run of the endpoint it calls (skipped steps do not): on Coverage & Risk, whichever is newer, the endpoint's own checks or a flow step, sets its status, shown as *via flow* when it comes from a flow. Check counts, categories, and coverage gaps still come from the endpoint's own checks.

APIs saved before 1.3 get their flows suggested the first time the Flows page opens.

**Edit** changes a flow's steps: their names, method, path, expected status codes, query parameters, JSON body, the values each step saves for later steps (a name, *the response* or *the request*, and a JSON Pointer such as `/id`), and whether a step runs even after an earlier one fails. Steps can be added, removed, and reordered, and **New flow** builds one from scratch. The editor marks a `{{value}}` that no earlier step saves before the flow can be saved. Edited and custom flows are saved with the API, survive importing the contract again, and run like suggested ones; **Reset to suggested** discards the edits. Body fields that look like credentials are not saved, like other request details.

On **Coverage & Risk**, a *Lifecycle flows passing* card counts the flows whose latest run passed, and a create endpoint whose flows have never run gets *Lifecycle not tested* (+10 to its risk score).

### Settings and backups

### Where data is saved

Saved APIs (with edited AI checks), Run history, and request details are saved by the backend in a SQLite database: `data/workspace.db` in a source checkout, `~/.api-qa-intelligence/workspace.db` for an installed package, or the folder set in `API_QA_DATA_DIR` (`GET /api/v1/workspace` and the `PUT`/`DELETE` routes under it). They survive clearing the browser and are shared by every browser that opens the same backend. Credential values are never stored: the backend drops request details that the contract marks as credentials or whose name says they are one (for example `password`, `pin`, `otp`, `session`, `token`), removes such keys from JSON bodies, and does so even if a client sends them. Request details saved by an older version are cleaned the next time the workspace loads. The database records its schema version and upgrades older files when the app starts.

The first time the app starts with an empty database, the saved APIs and runs from this browser's earlier storage move into it automatically; the browser keeps a copy only as a fallback. If the backend cannot be reached, the app keeps working with that browser copy and says so at the top of the page. To move data between machines, use **Export workspace** and **Import workspace**.

The **Settings** page shows whether the configured Ollama model is reachable and installed (`GET /api/v1/ai/status`), runs a step-by-step diagnosis — backend, Ollama server, required model, and a short inference test — with a suggested fix for any failing step (`GET /api/v1/ai/diagnose`; also started by clicking the AI status in the sidebar), exports the workspace as a JSON file, imports an export (APIs with the same id are replaced and existing runs are skipped), and can delete all saved data after confirmation.

### Optional AI features

The AI features are optional: importing, contract checks, runs, coverage, flows, and the CLI all work without them. To use them, install and run Ollama with a model. The default model is `qwen3-vl:8b-instruct`, and the default Ollama URL is `http://127.0.0.1:11434`. Override them with `OLLAMA_MODEL` and `OLLAMA_BASE_URL` before starting the backend. In an API overview, choose **Suggest scenarios** to send the selected endpoint’s contract details (operation, parameters, and body field names/types) to the configured model. The model receives no example values, credentials, target URL, or API traffic. It also receives the titles of the endpoint’s existing checks and is asked not to repeat them; ideas that still repeat an existing check are skipped. On endpoints without parameters or a request body, ideas stay review notes because a check made from them would repeat the contract check. Suggestions are review-only and are not runnable until you choose **Convert to check**, state the expected status codes, and decide for each parameter whether to use the request details, omit it, send it with an empty value (not available for path parameters), or send a custom value; the editor warns when a draft would send exactly the same request as another check; JSON bodies are sent exactly as written in the editor. Saved checks are labeled **AI idea · edited**, stay in this browser with the saved API, and run only when you select them, with the usual confirmation for data-changing methods. In a run’s details, choose **Analyze with AI** on a failed check to send that check’s redacted evidence for optional, advisory analysis. Read the on-screen disclosure before requesting either AI feature.

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

- **Checks saved in the app:** `--workspace export.json` (in place of `--spec`) runs an export from **Settings → Export workspace**: the contract-based checks, your edited AI checks, and the flows the Flows page shows (your edits to suggested flows and the flows you built). Unconverted AI ideas do not run. When the export holds several APIs, choose one with `--api` (its title or id). The target defaults to the one last used in the app, then the contract's first server. Exports never hold credentials, so pass them with `--header` as usual; path values come from `--param` or `--inputs`.
- **What runs:** the contract-based checks of every endpoint, with the response body checked against the documented schema. AI features are never used, so results are repeatable. `--smoke` runs only each endpoint's valid request; `--endpoint 'GET /pet/*'` narrows the endpoints.
- **Data-changing methods** (POST, PUT, PATCH, DELETE) are skipped unless you pass `--include-writes`.
- **Flows:** `--flows` also runs the contract's lifecycle flows (see [Flows](#flows)). They create and delete data, so they run only with `--include-writes`; otherwise they are reported as skipped. A path parameter a flow cannot derive comes from `--param name=value` or the `--inputs` file. Each flow is a JUnit test suite named `Flow: <title>` with one test case per step, and a failing step exits 1.
- **Request inputs:** parameters fall back to the contract's examples. Give missing ones with `--param name=value` (or `path:name=value`), or put them in a JSON file passed with `--inputs`, keyed by `"METHOD /path"` (or `"*"` for all endpoints) with the web app's input keys, for example `{"GET /pet/{petId}": {"parameter:path:petId": "10"}}`. An endpoint whose required inputs are still missing is reported as skipped, with the missing names; `--fail-on-skipped` turns that into a failure.
- **Credentials:** pass them with `--header`. They are sent with every check except one that deliberately leaves them out (such as *Call without authentication*), and their values are replaced with `[REDACTED]` everywhere in the reports.
- **Target:** defaults to the contract's first server (with `--workspace`, to the target saved in the app first). Private-network hosts (for example a Docker service name) are blocked unless you pass `--allow-private-network`.
- **Reports:** `--junit` writes JUnit XML (one test suite per endpoint, one test case per check, skipped checks marked as skipped), which GitHub Actions, GitLab, and Jenkins display as test results; `--json` writes the full results with redacted evidence. To count CI runs on **Coverage & Risk**, turn on **Advanced view**, choose **Add CI test results** there, and pick the `--json` file (for example the artifact of the CI job). The report is matched to the saved API with the same title; each endpoint that ran becomes a run marked **CI** in Run history, skipped endpoints add nothing, and importing the same report again adds nothing.
- **Results from other tools:** **Add CI test results** also reads a Newman JSON report (`newman run collection.json --reporters json`) or any JUnit XML, so a Postman collection or another test suite counts on Coverage & Risk for the active API. Newman records each request's method, URL, and status, so its tests are matched to endpoints by method and path (a base path such as `/api/v3` in front is fine). JUnit has no request fields, so a JUnit test is matched only when its suite, class, or name contains a request line such as `GET /pets/{id}` (the `api-qa` JUnit report does); others are counted and left out. Imported tests appear in Run history as **Newman** or **JUnit** runs with their outcome and failure message, count as tested and failing endpoints, and their response codes count for coverage gaps. Each imported test gets a category from its name, or from its status when it passed ("... without token" or a 401 is an authentication test, "too long" a boundary test, a 2xx the happy path), so it counts on the category strip, for *Only happy path tested* and *Auth not checked*, and for input gaps. Imported tests are counted next to the app's own checks on each Coverage row ("+ 2 imported tests"), not as one of them. Importing the same file again adds nothing.
- **Response time:** `--max-duration-ms 1000` fails a check whose response takes longer than one second.
- **Exit codes:** `0` when every check passed, `1` when a check failed or errored (or was skipped, with `--fail-on-skipped`), `2` for a usage or contract problem.

A ready-to-copy GitHub Actions job is in [`docs/examples/github-actions-api-qa.yml`](examples/github-actions-api-qa.yml).

## Postman collections and HAR files

**Fill from Postman or HAR** on the overview (it does not add an API) reads a Postman collection (v2.0 or v2.1) or a HAR file saved from the browser's developer tools and compares its requests with the contract: how many endpoints it calls, which endpoints it never calls, and which requests go to paths the contract does not document. Requests are matched like imported test results: same method, and the path template matches the end of the request's path, so a base path in front is fine. Postman variables are resolved from the collection's variables (`{{baseUrl}}`, `:petId` path variables); a HAR file keeps only API calls (fetch and XHR) and skips scripts, styles, and images.

**Fill request details** then reuses the values the file sends: path and query parameters and body fields of the endpoints it calls, filling only empty details unless **Replace values I already entered** is checked, and says how many more checks are ready to run. Headers, auth settings, and cookies are never read; query parameters, body fields, and variables with credential-like names, and values that look like secrets (bearer tokens, JWTs, card numbers), are left out and counted. Nothing is stored except the request details you fill, which follow the usual rules (credentials are never saved). `POST /api/v1/requests/parse` reads the file.

## Contract quality

Every import scores how well the contract supports testing, from 0 to 100 with a grade (A from 90, B from 75, C from 60, D from 40, F below). Fixed, weighted rules are checked on every endpoint they apply to: success responses have a JSON schema (3), required inputs have an example, default, or enum (3), a valid request can be built (2), 4xx responses are documented (2), inputs have limits such as a format, enum, length, or range (1), secured endpoints document 401 or 403 (1), endpoints that take a record id document 404 (1), unique operationIds (1), summaries (1), and input descriptions (1); the contract also needs a server (2). Rules that do not apply to an endpoint are left out, and some give partial credit (the share of inputs with an example). No AI is involved.

On the overview, the **Contract quality** card opens the report: the fixes worth most points, each rule's score, and the findings per endpoint, with **Open endpoint** and **Copy as Markdown**. In CI, `api-qa lint openapi.yaml --min-score 70` prints the score and top fixes, writes `--markdown` (`-` for standard output) and `--json` reports, and exits `1` below the minimum. `POST /api/v1/specs/quality` scores an overview; APIs saved before 1.11 are scored when their overview opens.

## Comparing contract versions

`api-qa diff` compares two versions of a contract, as files or URLs, from a client's point of view:

```bash
api-qa diff openapi-v1.yaml openapi-v2.yaml --markdown contract-diff.md --json contract-diff.json
```

- **Breaking** changes can make an existing client fail: a removed endpoint or success response, a new required parameter or body field, a stricter rule on a request value (a lower `maxLength`, a removed enum value, a new `pattern`), a changed type, authentication that is now required, or a response field that was removed or is no longer always present.
- **Warnings** deserve a look: a removed request input, a new success status, a response value that can now be null or take new enum values, or authentication that is no longer documented.
- **Safe** changes add something: new endpoints, optional inputs, response fields, or looser request rules.

Requests and responses are judged in opposite directions: a stricter rule breaks a client that sends values, but only promises less to one that reads them. Renaming a path parameter (`/pets/{id}` → `/pets/{petId}`) is the same URL and is reported as safe. For every endpoint with breaking changes or warnings, the report lists the checks worth running again (the valid request, and checks named after a changed input or about authentication).

`--markdown -` writes the report to standard output, for example for a pull request comment. The command exits `1` when a change is breaking (`--fail-on warning` also counts warnings, `--fail-on never` always exits `0`), and `2` when a contract cannot be read. [`docs/examples/github-actions-contract-diff.yml`](examples/github-actions-contract-diff.yml) compares the contract in a pull request with the base branch, comments the report, and fails on breaking changes. The same comparison is available as `POST /api/v1/specs/diff`.

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

Browser tests (Playwright) walk the main flows — import, passing and failing checks, schema differences, a missing-key finding, data surviving a cleared browser, Run again, a bulk run with data-changing endpoints, and Delete all — against a small target API with deliberate problems ([`frontend/e2e/target_api.py`](../frontend/e2e/target_api.py)). They start the app on a throwaway database; each test empties it and resets the target API first, then sets up what it needs, so any test can run alone (`npx playwright test e2e/workspace.spec.js:LINE`) and a retry starts clean:

```bash
cd frontend
npm run build
npm run test:e2e
```

Locally they use the installed Google Chrome; set `E2E_PYTHON` if the backend's Python is not `../.venv/bin/python`. Each run starts its servers on two ports that are free at that moment, so several runs on one machine do not collide; set `E2E_APP_PORT` and `E2E_TARGET_PORT` to choose them.

The same checks run on GitHub Actions for every pull request and push to `main` ([`.github/workflows/ci.yml`](../.github/workflows/ci.yml)): backend lint and tests, frontend tests and build, the browser tests, and a Docker image build with a smoke test.

## Backend API

Every feature of the web app goes through a documented HTTP API under `/api/v1`, which is stable for all 1.x releases: see [docs/API.md](API.md), and `/docs` on a running backend for the typed reference.

## Roadmap

[docs/MVP_ROADMAP.md](MVP_ROADMAP.md) records how the project was planned up to 1.0. Ideas after 1.0 include a hosted demo.

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

The current version is in [`VERSION`](../VERSION) (shown in the sidebar and returned by `GET /health`); see [CHANGELOG.md](../CHANGELOG.md) for what changed in each release.

## License

Released under the [MIT License](../LICENSE). © 2026 Berk Antepli
