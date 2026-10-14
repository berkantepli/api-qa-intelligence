# Changelog

The version lives in the [`VERSION`](VERSION) file and follows [Semantic Versioning](https://semver.org/). Before 1.0.0, a new feature raises the minor number (0.**x**.0) and a fix or visual change raises the patch number (0.x.**y**).

## Unreleased

### What changed
- **Compare with…** on Coverage & Risk lists each check that is newly failing, fixed, still failing, or slower (50% and 50 ms) against an earlier moment: before the latest run, 24 hours ago, or 7 days ago. A whole bulk run counts as one run. Each row opens its run.
- **Compare with the previous run** in run details does the same for one endpoint or flow.
- `api-qa run --baseline last.json` compares the run with an earlier `--json` report, prints the changes, and adds them to the JSON report; `--fail-on new` fails the pipeline only on checks that passed in the baseline.

### HTML reports
- **Download HTML report** in run details and **Export HTML** on Coverage & Risk save one self-contained file to send: a summary, the changes since the earlier results, coverage, and each check with the reason it failed and its masked evidence (passed checks' evidence on request). No scripts or external resources; every value is escaped.
- `api-qa run --html report.html` writes the same report from CI.
- New routes: `POST /api/v1/runs/compare` and `POST /api/v1/reports/html`.

## 1.21.0 — 2026-10-14

### Access check
- **Access check** under each lifecycle flow tests object-level authorization (OWASP API1:2023): the first user creates a record, a second user tries to read, change, and delete it and must get 403 or 404, and the first user checks the record is still there and cleans up. Each attempt gets its own answer in plain words; a 401 for the second user is reported as inconclusive, not as a pass.
- Only steps whose endpoint documents a credential are tried, so reading a public record is not a finding.
- The second user's credentials are typed in or taken from the contract's sign-in request (**Sign in as the second user**). They stay in the tab's memory only, are never saved, and are masked in evidence. Run history marks the second user's steps.
- The demo bookstore has a second reader (`second@example.com` / `second-password`) and remembers who added each book: deleting another reader's book is refused with 403, while replacing it is deliberately not, so the access check finds it. The demo tour has a step for it.

## 1.20.0 — 2026-10-14

- **Run the app's saved checks in CI.** `api-qa run --workspace export.json` runs a workspace exported from Settings: the contract's checks plus your edited AI checks, and with `--flows` the flows the Flows page shows, including edited suggestions and flows you built. `--api` picks one API when the export holds several; the target saved in the app is used unless `--target` is given. Credentials still come from `--header`, since exports never contain them. A saved flow that cannot be read is reported as skipped instead of being dropped.

## 1.19.2 — 2026-10-14

- **Slowed down** on Trends compares the range with the endpoint's usual speed, the median of the 90 days before the range, instead of only the same number of days just before. A slowdown that started before the range and has not recovered is no longer missed.
- The *Response changed* tag on Coverage & Risk also covers flow steps: an endpoint shows it when the latest run that called it changed, whether that was one of its own checks or a flow step.

## 1.19.1 — 2026-10-14

### Masked evidence
- Schema differences no longer quote a contract credential that the API echoed back in its response; a field named like a credential reads "[REDACTED] does not match the documented schema".
- A credential value is masked only where it appears as a value of its own, so a key such as `test` no longer turns "latest" into "la[REDACTED]" or cuts into ids; its JSON-escaped form is masked too.
- The response is masked before it is cut to 10,000 characters for display, so a credential across the cut is no longer partly visible.
- Short credentials (three characters or more) are masked where they are echoed, and a JSON field with a credential's name is masked whatever its length.
- Checks, flows, and the CLI's reports use one masking rule.

### Postman and HAR import
- Requests and values that are too long to read are counted on their own ("too long to read … left out") instead of as entries that are not API requests.
- A long query value is left out on its own; the request is kept.
- A request repeated in a HAR file counts its credential-like values once.
- `POST /api/v1/requests/parse` returns `too_long`.

## 1.19.0 — 2026-10-14

### Demo API
- **Try the demo API** on the import page (and on the empty API list) replaces the four public sample APIs. *Demo Bookstore* is served by the app itself under `/demo`, so it needs no internet and gives the same results every time. It has sign-in, books with full create-read-update-delete, orders, and a slow report, with deliberate problems for the checks to find: a schema break, an endpoint that skips authentication, validation gaps, and a slow response.
- A **Demo tour** on its overview links each problem to where it shows up; **Reset demo data** brings back the sample books. New route: `GET /api/v1/demo`.

### Fixes
- Bulk runs on Coverage & Risk and flows now send the API-wide credentials from **Target & auth**. Since 1.17.0 only checks run from the overview sent them, so protected endpoints answered 401 in bulk runs and flows.
- A path parameter with a documented example is sent with that example when nothing was entered. The check was offered as ready, but the request went to an empty path segment (for example `/books/`).

## 1.18.3 — 2026-10-14

### Security
- Credentials the contract documents under an ordinary name (for example an API key called `appid`, or an `X-Client` header) are now masked in evidence, Run history, exports, the evidence sent to Analyze with AI, and CLI reports, also when the API echoes them back. Checks and flows send the contract's credential names as `secret_names`.
- Postman and HAR imports: a collection variable repeated across requests can no longer expand a small file into gigabytes; long paths, values, and bodies are left out. A deeply nested JSON body no longer returns an error, and a JWT, bearer token, or card number inside a path is replaced with `{value}`.

### Other changes
- In the overview, "Same response structure as the last pass" under a passing check is gray instead of the red used for failure explanations.
- The README is a short introduction: what the app does, a quick start, how to use it, and where to go next. The full documentation moved to [docs/GUIDE.md](docs/GUIDE.md).

## 1.18.2 — 2026-10-13

- A contract without endpoints says so: the import notice is a warning, the overview explains that its paths object is empty instead of asking you to choose an endpoint, Runnable checks says "nothing to run yet", Coverage says there is nothing to cover, and the contract quality report points at the missing endpoints instead of the server URL (also in `api-qa lint`).
- A Postman collection or HAR file without API requests says so, instead of showing an empty comparison.
- A flow step with an unknown method or a malformed path is refused before anything is sent, with a plain message; it used to fail mid-run with a misleading one.
- A flow step that cannot reach the target shows the connection problem once, not twice.
- The quality card's top fix keeps capitals such as API and URL.
- `api-qa run`, `diff`, and `lint` say which report file could not be written and why, instead of a raw error.

## 1.18.1 — 2026-10-13

- Clearer names for buttons that read a file into the active API, so they are not mistaken for adding an API: **Import Postman or HAR** is now **Fill from Postman or HAR**, with a short note under it, and **Import test results** on Coverage & Risk is now **Add CI test results**.
- AI ideas say how they become runnable: the pill reads **Idea · convert to run**, and the heading explains Convert to check.
- **Backend API docs** moved from the sidebar to a **Backend API** card in Settings.

## 1.18.0 — 2026-10-13

- **Response changed since the last pass**: each check and flow step with a JSON response is compared with the last pass of the same check and status code. Run details list fields that disappeared or are new, fields whose type changed (such as number to string, or a value to `null`), and lists that became empty. Values are not compared, and the keys of documented maps (`additionalProperties`) are ignored, so changing ids and timestamps raise nothing. It never fails a check.
- The overview shows the changes under a check right after it runs. Run details tag such checks *Response changed*, and Coverage & Risk tags an endpoint whose latest run changed, with the changes on hover.

## 1.17.0 — 2026-10-12

### Target and authentication
- **Target & auth** in the topbar holds the active API's target URL, response time limit, and credentials, for every page. The endpoint panel shows a one-line summary with **Change** instead of the two fields.
- A credential the contract documents (an API key or `Authorization`) is entered once for the whole API and sent by every check, bulk run, and flow that needs it. An endpoint's own value still takes precedence, and *Call without authentication* still leaves it out.
- **Get a token from a sign-in request** sends one request to a sign-in endpoint and puts the token from its JSON response into the credential (`Bearer` is added for `Authorization`). New route: `POST /api/v1/auth/sign-in`.
- **Remember in this tab until it is closed** keeps credentials across reloads of the tab; they are still never saved to the workspace, evidence, or exports.

### Checks
- New contract checks: **Send the wrong type for …** for a typed path or query parameter and a typed body field (text where a number, boolean, array, or object is expected), and **Send an undocumented request field** when the schema sets `additionalProperties: false`. Both expect a documented 4xx response. Import an API again to get them.

### Simpler by default
- Coverage & Risk and the overview start in a simple view. **Advanced view** (on Coverage & Risk, or in Settings) adds the risk score and its rules, criticality, Trends, **Import test results**, and duplicate hints.
- The README starts with the one-line Docker command and marks the AI features as optional.

## 1.16.1 — 2026-10-12

- Summary cards stay on one line above phone width, whatever their number: Overview, Coverage & Risk (the Lifecycle flows card used to wrap onto a row of its own), the Postman and HAR panel, run details (a flow run's Skipped used to wrap), and the Settings facts. On phones they use two columns, and an odd last card takes the whole row.
- Trend charts sit side by side on wide screens and one per row below 1020 px, never two plus one.
- The Coverage & Risk cards are more compact, their numbers stay in line when labels wrap, and the quality grade stays next to its score.

## 1.16.0 — 2026-10-12

- **Endpoints tested** over time on **Trends**: the share of the contract's endpoints that had run at least once by each day, with the change over the range.
- **Slowed down** on **Trends** lists the endpoints whose median response time grew by at least 50% and 50 ms against the days before (3 or more timed checks in both ranges); select one to see its trend.
- The response time chart draws the API's response time limit as a dashed line.
- Each tested endpoint on **Coverage & Risk** shows a small line of its latest 12 runs' response times, with failed runs marked.

## 1.15.0 — 2026-10-12

- **Trends** on **Coverage & Risk**: the daily pass rate and the median and 95th-percentile response time over the last 7, 30, or 90 days, for the whole API or one endpoint, each compared with the same number of days before. Checks and flow steps both count; days without checks are left empty. Hover a day for its numbers, or open **Show as table**.

## 1.14.1 — 2026-10-12

- Removed a `frontend/node_modules` symlink that 1.14.0 committed by mistake (it pointed to a path on one developer's machine), and `.gitignore` now ignores `node_modules` whether it is a folder or a symlink.

## 1.14.0 — 2026-10-12

### Postman collections and HAR files
- **Import Postman or HAR** on the overview compares a Postman collection (v2.0, v2.1) or a browser HAR file with the contract: the endpoints it calls, those it never calls, and requests to paths the contract does not document.
- **Fill request details** reuses the file's path, query, and body values for the endpoints it calls (only empty details, unless you choose to replace yours) and says how many more checks are ready to run.
- Headers, auth settings, and cookies are never read; credential-like names and values that look like secrets are left out and counted.
- `POST /api/v1/requests/parse` reads the file.

## 1.13.0 — 2026-10-12

### Sample APIs
- The import page offers four public APIs to try when you have no contract at hand, each with a short note: **Swagger Petstore** (the classic example), **FakeRESTApi** (full CRUD whose writes are not kept, so flows are safe to run), **Toolshop** (a QA practice shop API with login and roles), and **PokéAPI** (large and read-only). Each imports with its target URL filled in.

## 1.12.0 — 2026-10-12

### Sharper coverage
- **Coverage gaps** match a runnable check to an input by what its request does compared with the valid request: it leaves the input out, or sends another value in a parameter, query, form field, or JSON body field. A title that names an input no longer counts on its own. AI ideas and imported tests are still matched by their words, and short, common names such as `id` or `name` need a clear form (`{id}`, "id parameter", "invalid id", "without name").
- Tests imported from Newman or JUnit get a category from their name, or from their status when they passed, so they count on the category strip, for *Only happy path tested* and *Auth not checked*, and for input gaps. Each Coverage row shows how many imported tests the endpoint has.
- *Sensitive area* also reads an endpoint's summary, tags, and operation id, and the names of its inputs (*Sensitive data: cardNumber*).
- A **Criticality** select on each Coverage row: **Critical** adds +20 *Marked critical* instead of the guess, **Not critical** drops *Sensitive area*. Marks are saved with the API and kept when it is imported again.

## 1.11.1 — 2026-10-12

- **New flow** opens with an empty flow name instead of a *Pet lifecycle* placeholder that looked filled in.

## 1.11.0 — 2026-10-12

### Contract quality
- Every import scores how testable the contract is, from 0 to 100 with a grade from A to F, using fixed weighted rules per endpoint: success response schemas, examples for required inputs, a buildable valid request, documented 4xx, 401/403 on secured endpoints, and 404 on record endpoints, input limits, unique operationIds, summaries, input descriptions, and a declared server.
- The overview's **Contract quality** card opens the report: the fixes worth most points, each rule's score, and the findings per endpoint, with **Open endpoint** and **Copy as Markdown**.
- `api-qa lint SPEC` prints the score and top fixes, writes Markdown and JSON reports, and exits 1 below `--min-score`.
- The API overview gains `quality`; `POST /api/v1/specs/quality` scores overviews saved before.

## 1.10.0 — 2026-10-12

- Flow steps now count toward endpoint coverage: an endpoint a flow step called counts as tested, and fails when that step failed. Skipped steps do not count. Whichever is newer, the endpoint's own checks or a flow step, sets its status, marked *via flow* on **Coverage & Risk**. Check counts, categories, and coverage gaps still come from the endpoint's own checks.
- The overview, API specs, and both coverage reports use the same numbers; the JSON report adds `status_source` (`check` or `flow`) per endpoint.
- Flow runs saved before this version count only for steps without a path parameter (such as `POST /pets`); run a flow again to count its other steps.

## 1.9.2 — 2026-10-12

- Opening an endpoint from **Coverage & Risk** (or **Run again** in Run history) scrolls the overview's endpoint list to it, so it is in sight in a long API.

## 1.9.1 — 2026-10-12

- The connection indicator shows **Slow to respond** when the target does not answer within the probe's time limit, instead of **API unavailable**; refused connections and unknown hosts still show API unavailable. The probe now waits up to 8 seconds, and its result includes `timed_out`.
- A check, bulk run, or flow step that gets a response marks the target as reachable, so the indicator no longer contradicts a run that just worked.

## 1.9.0 — 2026-10-12

### Results from other tools
- **Import test results** on **Coverage & Risk** (formerly Import CI report) also reads a Newman JSON report or JUnit XML, so a Postman collection or another test suite counts on coverage, risk scores, and coverage gaps for the active API.
- Newman tests are matched to endpoints by method and path, even with a base path such as `/api/v3` in front. A JUnit test is matched when its suite, class, or name contains a request line such as `GET /pets/{id}`, as in the `api-qa` JUnit report. Tests that match no endpoint and skipped tests are counted in the result message and left out.
- Imported tests appear in Run history as **Newman** or **JUnit** runs with their outcome, response status, and failure message (redacted like other evidence). Importing the same file again adds nothing.
- Backend: `POST /api/v1/results/parse` reads such a file into test cases. JUnit XML with a DOCTYPE or entities is refused.

## 1.8.2 — 2026-10-12

- The sidebar no longer shows a flow count next to **Flows**.

## 1.8.1 — 2026-10-12

Security and robustness fixes from a scan with a hostile target API and hostile contracts. No API, CLI option, or data format changes.

### Robustness
- A 1 KB YAML contract whose anchors and aliases expand to billions of values could freeze the whole app (and hang `api-qa diff`). Contracts are now refused past 1,000,000 values or 100 levels, and parsing runs off the event loop.
- A server that trickles its response held a check, flow step, connection probe, or OpenAPI download far past the stated timeout. Each now has an overall deadline.
- A deeply nested JSON response, a deeply nested or oddly shaped contract, and an overlong path no longer return HTTP 500; each gets a clear message.
- Request bodies over 32 MB are refused.

### Security
- The app can no longer be framed by other sites (clickjacking protection headers).
- Evidence masks `Bearer`/`Basic` credentials, JWTs, and card numbers found in free text, not only values under sensitive key names.
- Connections go to the address that was just checked, so a DNS answer that changes after validation (DNS rebinding) cannot reach a private network. NAT64, 6to4, and Teredo addresses that carry a private IPv4 address are blocked.
- Header names and values with line breaks are refused with a clear message.
- `localhost.` is treated like `localhost`.

## 1.8.0 — 2026-10-12

### Contract changes
- `api-qa diff BASE HEAD` compares two versions of a contract and classifies every change from a client's point of view: **breaking** (removed endpoints or success responses, new required inputs, stricter request rules, changed types, authentication now required, response fields removed), **warning** (removed request inputs, new success statuses, response values that can be null or take new enum values, authentication no longer documented), or **safe**.
- Requests and responses are judged in opposite directions, and a renamed path parameter counts as the same endpoint.
- Each endpoint with breaking changes or warnings lists the checks worth running again.
- `--markdown` writes a report for a pull request comment (`-` for standard output) and `--json` the full result; the command exits 1 on breaking changes (`--fail-on warning|never` changes that). A GitHub Actions example comments the report on pull requests.
- `POST /api/v1/specs/diff` runs the same comparison on two API overviews and also returns the report as Markdown.
- **Contract changes** on Coverage & Risk classifies each change of a new import as Breaking, Warning, or Safe, shows the totals and the checks to run again per endpoint, and **Copy as Markdown** copies the report. Changes saved by earlier versions keep their plain list.

## 1.7.0 — 2026-10-12

### Flows
- `api-qa run --flows` runs the contract's lifecycle flows in CI. They need `--include-writes` and are reported as skipped without it; path parameters a flow cannot derive come from `--param` or `--inputs`. Each flow is a JUnit test suite with one test case per step, the JSON report gains `flows` and flow totals, and a failing flow exits 1.
- Importing a CLI report on Coverage & Risk also brings its flows into Run history.
- A nested collection such as `/owners/{ownerId}/pets` no longer needs `ownerId` typed in: its flow first creates an owner with the owner's flow and deletes it at the end.
- When the create response is not documented and has no `id` field, the new record's id is taken from the last part of the `Location` header.
- **Edit** a flow on the Flows page: rename, add, remove, and reorder steps, and change each step's method, path, expected status codes, query, JSON body, saved values, and whether it runs after a failure. **New flow** builds one from scratch. Edited and custom flows are saved with the API and kept when the contract is imported again; **Reset to suggested** discards the edits.
- Coverage & Risk shows how many lifecycle flows pass, and flags a create endpoint whose flows never ran as *Lifecycle not tested* (+10 risk).

## 1.6.0 — 2026-10-11

### Re-imports
- Importing from the same URL or file name counts as the same API even when the contract's title changed: the contracts are compared and the saved API keeps its runs, checks, and settings under the new title.
- When a new import has the same title as a saved API from another source, the overview offers **Merge into it** (a new version: compare and keep its runs, checks, target URL, and time limit) or **Keep separate** (for example staging and production).
- Saved AI checks that no longer fit the contract are marked *Review against the current contract* on their card and listed under **Contract changes**: they send or leave out a parameter or body field the contract no longer has, send a body the endpoint no longer takes, or expect an undocumented status code.

### Fixes
- A new endpoint is scored once, as *Never tested*, instead of also getting +15 *New in the contract*. Changed endpoints still add +15 *Changed in the contract* until they run again.

## 1.5.0 — 2026-10-11

### Contract changes
- Importing a saved API again (same title and the same URL or file name) compares the two contracts. The overview says how many endpoints are new, changed, or removed.
- **Contract changes** on **Coverage & Risk** lists them with each change as a sentence: new or removed parameters and body fields, required and credential changes, schema rules such as `maxLength` or `enum`, request body changes, new or removed response codes, and changed response schemas.
- A new or changed endpoint adds +15 to its risk score (*New in the contract* or *Changed in the contract*) until it runs again; the **Changed** filter lists those endpoints. Both reports include the comparison.

### Fixes
- Importing a saved API again no longer loses your edited AI checks, AI ideas, target URL, and response time limit. Checks on endpoints the new contract removed are dropped and counted.
- The import message is shown on the overview, where the app opens after an import.

## 1.4.0 — 2026-10-11

### CI runs on Coverage
- **Import CI report** on **Coverage & Risk** adds the checks from an `api-qa run --json` report, so checks run in CI count on coverage, risk scores, and coverage gaps like checks run in the browser.
- The report is matched to the saved API with the same title (the active API first, then the same version). Each endpoint that ran becomes a run marked **CI** in Run history and Run details; skipped endpoints add nothing.
- Importing the same report again adds nothing. Endpoints the saved API does not have, and a report for another API version, are named in the result message.
- The GitHub Actions example installs a 1.x release and explains how to use the uploaded report.

## 1.3.0 — 2026-10-11

### Flows
- A new **Flows** page, next to Coverage in the sidebar, suggests multi-step checks that follow one record through its lifecycle: create it, read it back, update it, delete it, and confirm it is gone. A created record's id is passed to the following requests.
- Flows come from the contract: an OpenAPI `link` names the value to pass on; without one, the item path's parameter (`{petId}`) is matched to a field of the create response or the request body, and the flow says how it was found.
- **Run flow** asks for confirmation and runs the steps in order against the active target, each judged like a single check (status, documented schema, time limit). After a failure the remaining steps are skipped, but the cleanup delete still runs when the record was created.
- Path parameters a flow cannot derive and credentials are entered on the flow; credentials typed in the overview are reused and never stored. Values saved under sensitive names (such as a token) are redacted in the evidence.
- Flow runs appear in Run history with each step's request and response, the values it saved, and why a step was skipped. **Run again** opens the API's flows. Endpoint coverage still counts single-endpoint runs only.
- Backend: `POST /api/v1/flows/execute` runs a flow and `POST /api/v1/flows/suggest` suggests flows for a list of operations; the API overview gains `flows` and each operation its `links`. APIs saved before this version get their flows the first time the Flows page opens.

## 1.2.0 — 2026-10-11

### Coverage gaps
- Below each endpoint on **Coverage & Risk**, **coverage gaps** list what its checks do not cover yet, as sentences such as *No invalid-value check for path parameter id* or *HTTP 404 is documented, but no check expects it*.
- For every input (parameters other than credentials, body fields other than files) the contract decides which checks apply: leaving out a required query, header, or body input; boundary values for documented limits; an invalid value for path parameters, numbers, booleans, and inputs with a `format`, `pattern`, or `enum`. Each is shown as passed, failing, not run, idea only, or no check.
- Every documented response code is shown as received in a run, never received, or not expected by any check.
- A **Has gaps** filter; the Markdown report has a Coverage gaps section and the JSON report lists gaps, inputs, and response codes per endpoint.
- The API overview's operations include `response_codes`: every documented response code, with or without a JSON body. APIs imported before this version list only codes with a JSON body until they are imported again.

## 1.1.0 — 2026-10-11

### Explainable risk score
- Every endpoint on **Coverage & Risk** has a risk score from 0 to 100 (high from 50, medium from 25), and the list is ordered by it, highest first.
- The score is the sum of fixed rules, and each rule that added points is shown next to it, for example *+20 Deletes data*, *+10 Sensitive area: orders*, *+35 Failing in latest run*.
- Impact rules come from the contract: deletes or changes data, requires authentication, a path that names accounts, users, orders, payments, or access control. Evidence rules come from Run history: failing, flaky, never tested, auth not checked, only happy path tested, checks not run yet, not run in 7+ days.
- **How the risk score works** lists every rule with its points. No AI is involved, so the same history always gives the same score.
- A **High-risk endpoints** card and a **High risk** filter; the Markdown and JSON reports include each score, its level, and its reasons.

## 1.0.2 — 2026-10-11

### Security
- Credentials typed into a request body are no longer saved. Saved request details used to leave out only parameters the contract marks as credentials, so a body field such as `password` was kept in the workspace database and the browser copy. Fields whose name gives them away (`password`, `pwd`, `pin`, `otp`, `session`, `signature`, `private_key`, `token`, …) are now left out, and such keys are removed from JSON bodies too.
- Request details saved by an earlier version are cleaned the next time the workspace loads.
- Run evidence and the evidence sent to **Analyze with AI** also mask session ids, signatures, PINs, and one-time codes; **Fill with AI** never generates them.

## 1.0.1 — 2026-10-11

Fixes from a review of every error path and negative scenario. No API, CLI option, or data format changes.

### Behaviour
- Run selected and the bulk run stay disabled while the target URL is empty, malformed, or blocked, and say why. The topbar shows **No target URL** or **Invalid target URL**, and an unknown host is reported as unreachable rather than blocked.
- Results and errors from an earlier run no longer stay on screen after a rejected run or when another endpoint is opened.
- "Omit a required parameter" leaves out only query and header parameters; leaving out a path parameter used to test a different URL.
- CLI: an `--endpoint` pattern that matches nothing exits 2 instead of passing with zero checks; `--target` and `--max-duration-ms` are checked before anything is downloaded.

### Messages
- Failed checks and connection probes say why: connection refused, unknown host, timeout, or a broken response.
- OpenAPI import names the OpenAPI URL, tells 404, authentication, redirects, server errors, and a closed port apart, and calls out HTML pages and other files that are not OpenAPI documents.
- A blocked private address explains `API_QA_ALLOW_PRIVATE_NETWORK=1` / `--allow-private-network`.
- One AI-unavailable message; files and databases from a newer version say to update the app.
- The web app shows field-level messages instead of raw validation text, and says the app server is not responding instead of "Failed to fetch".

### Interface
- Run and AI errors appear next to their button, with an icon, and scroll into view.
- Empty required request fields are marked on the field; a stale "Every field already has a value." summary disappears.
- An out-of-range response time limit shows an error instead of being silently changed.
- Settings clears old messages and confirms Delete all; copy that still said data lives in this browser is updated.

## 1.0.0 — 2026-10-09

The first stable release. API QA Intelligence turns an OpenAPI 3.x or Swagger 2.0 contract into risk-aware QA checks, runs them from the browser, in bulk, or from CI, judges each response by its status, documented schema, and time limit, keeps redacted evidence, and shows coverage and risk per endpoint. A local Ollama model can add scenario ideas, sample values, and failure explanations.

### What 1.0 promises
- The `/api/v1` HTTP API is stable for all 1.x releases: routes and fields may be added, never removed or renamed ([docs/API.md](docs/API.md)). A test guards this.
- The `api-qa` command line keeps its options, exit codes, and report formats.
- Workspace databases and workspace export files from 1.x keep working; older databases are upgraded when the app starts.

### New in 1.0
- The Docker image is published to GitHub Container Registry with each release: `docker run -p 8001:8001 -v api-qa-data:/data ghcr.io/berkantepli/api-qa-intelligence`.
- The project is licensed under MIT.

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
