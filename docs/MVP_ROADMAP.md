# MVP roadmap

## Product goal

Help a QA engineer go from an API contract to reviewed, executable test scenarios and evidence-based failure explanations. The tool should answer “what should I test and what does this result tell me?” rather than focus on manually composing requests.

## Milestones

### 0. Repository foundation

- Agree on the product boundary and MVP.
- Keep the first milestone backend-led and small.
- Add implementation instructions after the repository is created.

### 1. OpenAPI import and inspection

- Accept local JSON/YAML OpenAPI documents.
- Validate the document and report actionable import errors.
- Normalize operations, parameters, request bodies, and responses into internal models.
- Do not make outbound API calls during import.

### 2. Deterministic scenario generation

- [x] Generate initial happy-path, required-field, invalid-value, boundary, and authentication-minded suggestions from imported contract details.
- [x] Include a rationale and mark suggestions that need review.
- [x] Include executable request examples when the path and JSON contract provide enough detail.
- Keep scenarios editable in the product interface.

### 3. Controlled execution

- [x] Require an explicit target base URL and request details for a single check.
- [x] Run a single HTTP check with a bounded timeout and response size; do not follow redirects.
- [x] Report PASS/FAIL from the expected status code, or ERROR when the API cannot be reached.
- [x] Execute a user-selected batch of checks and summarize the results.
- [x] Record request/response evidence for each selected check, with secrets redacted and uploaded file contents excluded.
- Avoid arbitrary code execution from generated test content.

### 4. AI-assisted QA analysis

- [x] Add an Ollama adapter with configurable URL/model settings.
- [ ] Use AI to propose additional scenarios.
- [x] Explain failed checks from recorded evidence on explicit user request.
- [x] Keep deterministic test outcomes authoritative and label AI analysis as advisory.
- [x] Keep model calls opt-in, redact credential-like values, and never send API traffic to a model.

### 5. Usable interface and expansion

- Add a focused UI after the backend workflow is stable.
- Consider coverage/risk summaries, duplicate-scenario detection, saved projects, and CI output.
- Revisit authentication and hosted execution only if deployment becomes an explicit goal.

## Out of scope for the first MVP

- Recreating a general-purpose API client or collection editor.
- Unattended scanning of arbitrary public APIs.
- Load/performance testing.
- Automatic destructive test execution.
- Multi-tenant cloud accounts and billing.

## MVP acceptance direction

A user can import a representative OpenAPI file, review generated scenarios and their rationale, choose which to execute against a configured test API, inspect evidence for PASS/FAIL outcomes, and request an explanation for a failure.
