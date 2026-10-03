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

- Generate baseline happy-path, required-field, invalid-value, and boundary scenarios from the contract.
- Keep each scenario editable and show why it was suggested.
- Distinguish contract-derived checks from assumptions that need review.

### 3. Controlled execution

- Require explicit target base URL and user selection before execution.
- Execute a selected scenario set with HTTPX and bounded timeouts.
- Record request/response evidence and report each check as PASS or FAIL.
- Avoid arbitrary code execution from generated test content.

### 4. AI-assisted QA analysis

- Add an interchangeable AI provider adapter.
- Use AI to propose additional scenarios and explain failures from recorded evidence.
- Keep deterministic test outcomes authoritative; label AI analysis as advisory.
- Never send secrets or API traffic to a model by default.

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
