# API QA Intelligence

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

The backend imports an OpenAPI 3.x JSON/YAML file or URL and returns a readable operation overview with deterministic baseline QA scenario suggestions and JSON request examples when it can safely derive them. It can execute one check or a selected batch, compare response statuses with expected codes, and record redacted request/response evidence in Run history. On request, Ollama can suggest extra review-only ideas for a selected endpoint or provide advisory analysis of a failed check; deterministic results remain authoritative.

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

To run one explicit check, use `POST /api/v1/runs/execute`. Provide a base URL (it may include the server’s base path, such as `https://petstore3.swagger.io/api/v3`; the operation path is appended to it), method, path, optional query parameters, headers or JSON body, and expected status codes. For example:

```json
{
  "base_url": "http://127.0.0.1:8000",
  "method": "GET",
  "path": "/health",
  "expected_status_codes": [200]
}
```

Only call APIs you own or are authorized to test. Execution does not happen during import, and redirects are not followed.

For a selected set of checks, use `POST /api/v1/runs/execute-batch` with a `scenarios` array containing the same fields as the single-check request. The response includes a PASS/FAIL/ERROR summary and per-check request/response evidence. Sensitive header and body values are redacted, and uploaded file contents are not included in the evidence. Credentials derived from an operation’s security requirement (for example an `Authorization` header or an API key) are shown as optional *credential* fields: fill them to call the API authenticated, or leave them empty to send the request without credentials. JSON examples are only generated when the contract provides enough information; path parameters and non-JSON request bodies still need a manual example.

Saved APIs can be deleted from the API specs page (trash icon, then confirm). Deleting removes the API’s contract, scenarios, and edited AI checks from this browser; its Run history is kept.

### Run history

Every executed batch is saved in this browser’s Run history, grouped by API with pass/fail/error totals and the most recently used API first. Open a run to see its target, PASS/FAIL/ERROR counts, and, for each check, the expected and received status, duration, the request line with headers and body, and the response status, headers, and body. Failed and errored checks open expanded. Delete a single run with the trash icon on its row, or every run for an API with the trash icon on the group header; both ask for confirmation and cannot be undone. Evidence is stored already redacted; uploaded file contents are never stored.

### Optional AI features

Install and run Ollama with a model. The default model is `qwen3-vl:8b-instruct`, and the default Ollama URL is `http://127.0.0.1:11434`. Override them with `OLLAMA_MODEL` and `OLLAMA_BASE_URL` before starting the backend. In an API overview, choose **Suggest scenarios** to send the selected endpoint’s contract details (operation, parameters, and body field names/types) to the configured model. The model receives no example values, credentials, target URL, or API traffic. Suggestions are review-only and are not runnable until you choose **Convert to check**, state the expected status codes, and decide for each parameter whether to use the request details, omit it, or send a custom value; JSON bodies are sent exactly as written in the editor. Saved checks are labeled **AI idea · edited**, stay in this browser with the saved API, and run only when you select them, with the usual confirmation for data-changing methods. In a run’s details, choose **Analyze with AI** on a failed check to send that check’s redacted evidence for optional, advisory analysis. Read the on-screen disclosure before requesting either AI feature.

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

## Roadmap

See [docs/MVP_ROADMAP.md](docs/MVP_ROADMAP.md) for the staged plan and product boundaries.

## Security and responsible use

- Run checks only against APIs you own or are authorized to test.
- Never commit credentials, API tokens, or private OpenAPI specifications.
- Configure the target host explicitly; generated scenarios should not silently send requests.
- Treat AI-generated scenarios and failure explanations as suggestions that need review.

## Project status

Early MVP. The app can import and summarize an OpenAPI 3.x file or URL, suggest contract-based scenarios, request additional review-only AI scenario ideas, execute selected checks, retain redacted run evidence, and optionally analyze failed checks. Coverage/risk summaries and broader provider support remain future work.

## License

Personal learning and portfolio project.
