# API QA Intelligence

[![CI](https://github.com/berkantepli/api-qa-intelligence/actions/workflows/ci.yml/badge.svg)](https://github.com/berkantepli/api-qa-intelligence/actions/workflows/ci.yml)

API QA Intelligence reads an API's contract (an OpenAPI or Swagger file) and tests the API for you. It writes the checks itself, runs them against your API, and shows what passed, what failed and why, and which parts of the API were never tested.

You give it a contract; it gives you a test plan, results with the full request and response, a coverage and risk view per endpoint, and multi-step tests that follow one record from create to delete. Everything runs on your own computer. The AI features are optional and use a local model, so no contract or API traffic leaves your machine.

> **Note:** This is a learning and portfolio project. Only test APIs you own or are allowed to test.

---

## Quick start

The easiest way is Docker, with nothing else to install:

```bash
docker run -p 8001:8001 -v api-qa-data:/data ghcr.io/berkantepli/api-qa-intelligence
```

Open <http://localhost:8001>. To try it without a contract of your own, choose **Try the demo API** on the import page: a small bookstore API built into the app, with deliberate problems to find and a short tour. It needs no internet.

<details>
<summary>Run from source instead</summary>

You need **Python 3.11+** and **Node.js**.

```bash
git clone https://github.com/berkantepli/api-qa-intelligence.git
cd api-qa-intelligence
python3 -m venv .venv
source .venv/bin/activate        # Windows: .venv\Scripts\activate
pip install -e ".[dev]"
cd frontend && npm install && npm run build && cd ..
uvicorn app.main:app --app-dir backend --port 8001
```

Open <http://127.0.0.1:8001>.

</details>

---

## How to use it

1. **Import a contract.** Upload an OpenAPI 3.x or Swagger 2.0 file (JSON or YAML), paste its URL, or try the built-in demo API.
2. **Set the target.** Under **Target & auth** at the top, check the address your requests go to and enter a token if the API needs one.
3. **Run checks.** In the **Overview**, pick an endpoint, fill in any required values (such as an id), select checks, and click **Run selected**.
4. **Read the results.** Each check shows **PASS**, **FAIL**, or **ERROR** with the reason. **Run history** keeps every run with the full request and response.
5. **See the big picture.** **Coverage** shows which endpoints are tested, failing, or risky. **Flows** tests a record from create to delete.

---

## What you get

| Page | What it shows |
|---|---|
| **Overview** | Every endpoint with ready-made checks: a valid request, a missing required input, values at and past documented limits, wrong types, and a call without credentials. Each response is checked for its status code, the documented schema, and an optional time limit. |
| **Coverage & Risk** | Which endpoints are tested, failing, or never tested, what each one's checks still miss (inputs and response codes), and a risk score that says where to look first. **Run checks** runs a whole filter at once. |
| **Flows** | Multi-step tests built from the contract: create a record, read it, update it, delete it, and confirm it is gone, passing the new id from step to step. |
| **Run history** | Every run with its request, response, and the reason for each result. Secrets are hidden before anything is saved. |
| **Trends** *(advanced view)* | Pass rate, response times, and the share of tested endpoints per day, plus the endpoints that got noticeably slower. |
| **Contract quality** | A 0–100 score for how testable the contract is, with the fixes worth most points. |

---

## Good to know

- **No AI is needed for testing.** Checks come from fixed rules, so the same contract always gives the same checks and results. The optional AI (a local [Ollama](https://ollama.com) model) suggests extra test ideas, fills in sample values, and explains failures; its output is a suggestion and never changes a result.
- **A response can pass and still be worth a look.** When a check's response loses a field, gets a new one, changes a type, or returns an empty list compared with its last pass, the result says so. This does not fail the check.
- **Data-changing requests ask first.** POST, PUT, PATCH, and DELETE checks and flows run only after you confirm, and flows clean up the records they create.
- **Credentials are never saved.** Tokens stay in the open browser tab and are hidden in run history, exports, and reports.
- **Your work is kept.** Contracts, checks, and runs are saved in a local database and survive closing the browser. **Settings** exports and imports the whole workspace.
- **Importing a new version** of a contract shows what changed and which changes break existing clients.
- **Start simple.** Coverage and the overview show the essentials first; **Advanced view** adds risk scores, trends, and test results imported from other tools.

---

## Use it in CI

The `api-qa` command runs the same checks without the web app, so a pipeline can test an API on every change:

```bash
api-qa run --spec openapi.yaml --target https://staging.example.com --junit report.xml
api-qa lint openapi.yaml --min-score 70          # fail when the contract is hard to test
api-qa diff openapi-v1.yaml openapi-v2.yaml      # fail on breaking changes
```

Ready-to-copy GitHub Actions jobs are in [`docs/examples`](docs/examples). Results from Newman (Postman) and other JUnit test suites can also be imported, so they count on Coverage.

---

## How it works

```text
OpenAPI / Swagger contract
        │
        ▼
Read the endpoints, inputs, and response schemas
        │
        ▼
Write checks from fixed rules ─────▶ optional: AI suggests extra ideas
        │
        ▼
Send the requests you select to your target
        │
        ▼
Judge each response: status code, schema, time limit
        │
        ▼
Results, run history, coverage, risk, and trends
```

---

## Security and limitations

The app is meant to run **on your own computer for one user**:

- It has **no login**. It answers only on `localhost`; do not expose it to a network you do not trust.
- Requests go only where you point them, start only when you click run, and never follow redirects. Your own computer is allowed; other hosts on a private network are refused unless you allow them.
- Checks test what the contract documents. If the contract is incomplete, the checks are too; the contract quality score shows where.
- It does not do load or performance testing; response times are measured per request.
- AI suggestions need review before you rely on them.

---

## For developers

**Tech stack:** Python, FastAPI, Pydantic, HTTPX, SQLite, React with Vite, Ollama (optional), pytest, Vitest, Playwright.

**Tests:** `pytest` for the backend, `npm test` in `frontend` for the interface logic, and `npm run test:e2e` for browser tests against a small API with deliberate bugs. GitHub Actions runs all of them on every pull request.

**Project structure:**

```text
backend/app/
├── api/            # HTTP routes under /api/v1
├── domain/         # Contract parsing, check generation, execution, flows, reports
├── integrations/   # Ollama adapter
└── cli.py          # The api-qa command
frontend/src/       # React interface
frontend/e2e/       # Browser tests and their target API
docs/               # Full guide, HTTP API, examples
```

**More detail:** the [full guide](docs/GUIDE.md) explains every feature and option, [docs/API.md](docs/API.md) describes the HTTP API (also at `/docs` while the app runs), and [CHANGELOG.md](CHANGELOG.md) lists what changed in each release.

---

## License

Released under the [MIT License](LICENSE). © 2026 Berk Antepli
