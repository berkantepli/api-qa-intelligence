# Changelog

The version lives in the [`VERSION`](VERSION) file and follows [Semantic Versioning](https://semver.org/). Before 1.0.0, a new feature raises the minor number (0.**x**.0) and a fix or visual change raises the patch number (0.x.**y**).

## 0.8.0 — 2026-10-09

### Docker
- The app runs with `docker run -p 8001:8001 -v api-qa-data:/data api-qa-intelligence`: web app, backend, and the `api-qa` CLI in one image, with the workspace database in a volume.
- `API_QA_ALLOW_PRIVATE_NETWORK=1` lets a server reach private-network targets (off by default), for example an API on the host machine through `host.docker.internal`.

### Security
- The backend answers only to `localhost` and `127.0.0.1` (plus names in `API_QA_ALLOWED_HOSTS`), so a web page using DNS rebinding cannot read or delete the workspace or send checks through it.
- A contract whose schemas `$ref` each other many levels deep can no longer hang an import: schema expansion stops at a fixed size.
- Development dependencies updated (Vitest 5) to clear audit advisories.

### Quality
- Playwright browser tests cover the main flows against a target API with deliberate problems, and run on every pull request together with a Docker image build.
- **Select all** also shows for endpoints with a single check.

## 0.7.0 — 2026-10-08

### Swagger 2.0
- Swagger 2.0 contracts can now be imported (file or URL, and with the CLI). They are converted to OpenAPI 3 on import, so scenarios, schema checks, and reports work the same; the overview shows the original version.
- Array parameters such as `?status=` are prefilled with a documented value.

### Bulk runs that change data
- **Run checks** on the Coverage page can include POST, PUT, PATCH, and DELETE endpoints when **Include data-changing endpoints** is turned on. They run after read-only checks (creates first, deletes last) and only after a second confirmation naming how many data-changing checks go to which target.

## 0.6.0 — 2026-10-08

### Saved data survives the browser
- Saved APIs (with edited AI checks), Run history, and request details are now saved by the backend in a SQLite database (`data/workspace.db`, or `API_QA_DATA_DIR`) instead of only in the browser. Clearing the browser no longer loses them, and every browser that opens the same backend sees the same workspace.
- On first start, the data already saved in this browser moves into the database automatically. If the backend cannot be reached, the app keeps working with the browser copy and says so.
- Credential values are never stored, even if a client sends them.

### Response time limits
- An optional **Response time limit** per API fails a check whose response is slower, with the reason, for example "took 2300 ms (limit 1000 ms)". The CLI has `--max-duration-ms`.

## 0.5.0 — 2026-10-08

### Everyday flows
- **Select all** selects every runnable check of an endpoint in one click (and **Clear selection** undoes it).
- Each endpoint in the overview list shows a green or red dot for its latest run.
- The overview's Methods card is replaced by **Endpoints tested**, which shows failing endpoints and opens Coverage & Risk.
- **Run again** in a run's details opens its endpoint with the same checks selected, so a fix can be rechecked in two clicks.
- **Try the Swagger Petstore sample** on the import page imports a public contract when you have no spec at hand.

## 0.4.1 — 2026-10-08

### Fixes
- A failed check in the overview now says what was expected, for example "Expected HTTP 401 or 403, received HTTP 200.", instead of only the received status.
- In the dark theme, the endpoint path in the checks header no longer looks disabled.
- The Runnable checks card says how many checks can run now and how many still need request details, instead of calling every check "ready to execute".
- On phones, the AI Suggestions button stays inside its card.

## 0.4.0 — 2026-10-08

### Command line for CI
- New `api-qa run` command runs a contract's checks without the web app, so a CI pipeline can test an API on every change. It is installed with the package (`pip install "git+https://github.com/berkantepli/api-qa-intelligence@v0.4.0"`).
- Writes a JUnit XML report that GitHub Actions, GitLab, and Jenkins show as test results, and a JSON report with redacted evidence; exits `0` when every check passed, `1` on a failure, `2` on a usage problem.
- Safe by default: POST, PUT, PATCH, and DELETE run only with `--include-writes`, private-network targets only with `--allow-private-network`, and AI features are never used.
- Request inputs come from the contract's examples, `--param`, or an `--inputs` file; endpoints still missing inputs are reported as skipped with the missing names.
- Credentials passed with `--header` are left out of checks that test missing authentication and are redacted everywhere in the reports.
- A ready-to-copy GitHub Actions job is in `docs/examples/github-actions-api-qa.yml`.

## 0.3.0 — 2026-10-08

### Response schema checks
- A check now also fails when the status is the expected one but the JSON body does not match the schema the contract documents for that status (an exact code, a range such as `4XX`, or `default`).
- The check covers types (including `nullable` and type lists), `enum`/`const`, required and documented properties, `additionalProperties: false`, array items, numeric and length bounds, and `allOf`/`anyOf`/`oneOf`. `format` and `pattern` are not enforced.
- Results list the differences by JSON path, for example `$[31].name: required property is missing`, in the overview and in Run history; **Analyze with AI** receives them too.
- APIs imported before this version need to be imported again to get response schemas.

### Fixes
- Headers such as `X-Key` or `Subscription-Key` are now redacted in run evidence like other credentials.
- `pip install -e ".[dev]"` works on a clean machine: the Python package is declared explicitly.

### Development
- GitHub Actions runs backend lint and tests and frontend tests and build for every pull request.

## 0.2.1 — 2026-10-08

### Fixes
- Endpoints with no parameters or request body no longer show AI suggestions: every check for them would send the same request as *Valid request*, so the ideas could never become checks. A short note explains this instead.

## 0.2.0 — 2026-10-08

### Coverage & Risk
- New **Coverage** page: endpoints tested, failing endpoints, untested data-changing endpoints, and checks executed for the active API.
- Each endpoint shows its latest status, how many runnable checks ran, and risk flags such as *Changes data, not tested*, *Only happy path tested*, *Auth not checked*, *Flaky results*, and *Not run in 7+ days*.
- A category strip per endpoint shows which kinds of checks (happy path, negative, boundary, invalid value, auth) passed, failed, have not run, or have no runnable check.
- **Run checks** runs the checks of every endpoint in the current filter in one go, after showing which endpoints are ready, which still need request details, and which change data (never included).
- **Export Markdown** / **Export JSON** download the coverage summary as a shareable report.
- Each saved API on **API specs** shows a coverage ring with a red dot when an endpoint is failing.

### Checks
- *Call without authentication* is now a runnable check: it leaves the documented credentials out and expects 401 or 403.
- Credentials derived from an operation's security requirement are optional, so checks can also run unauthenticated.
- Request details you enter are kept in this browser per saved API (never credential values).
- A target URL may include a base path.

### AI features (Ollama, optional)
- Turn AI scenario ideas into editable, runnable checks; a parameter can be omitted, sent empty, or given a custom value.
- **Fill with AI** fills empty request fields with schema-valid sample values.
- AI ideas are told which checks already exist; ideas that still repeat one are skipped, and possible duplicate scenarios are flagged.
- Settings shows the AI model status and a step-by-step diagnosis.

### Workspace
- Run history groups runs by API, opens a run's request/response details, and can delete runs or whole groups.
- Saved APIs can be deleted; the workspace can be exported, imported, or cleared from Settings.
- The topbar checks whether the target API is reachable through the backend.
- The sidebar shows the AI status, a link to the backend API docs, and this version, which links to its release notes.

### Look and feel
- Pages fill the screen at every width, larger text throughout, and clearer import, alert, and Settings labels.

## 0.1.0 — 2026-10-05

First MVP: import an OpenAPI 3.x file or URL, review endpoints and contract-based QA scenarios, run selected checks against a target API with confirmation for data-changing methods, keep redacted request/response evidence in Run history, and optionally ask a local Ollama model for scenario ideas and failure analysis.
