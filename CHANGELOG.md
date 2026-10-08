# Changelog

The version lives in the [`VERSION`](VERSION) file and follows [Semantic Versioning](https://semver.org/). Before 1.0.0, a new feature raises the minor number (0.**x**.0) and a fix or visual change raises the patch number (0.x.**y**).

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
