# AI API QA Assistant

An AI-assisted API quality platform that turns an OpenAPI description into thoughtful, risk-aware tests, runs selected checks, and explains failures in a QA context.

This project is **not a Postman replacement**. Its focus is helping teams decide what to test, see meaningful coverage gaps, and understand what a failure may mean.

## Product flow

```text
OpenAPI / Swagger → API understanding → QA scenarios → selected test execution → failure analysis
```

## Planned MVP

- Import an OpenAPI JSON or YAML file.
- Inspect operations, parameters, request bodies, and response schemas.
- Generate editable happy-path, negative, boundary, validation, and security-minded scenarios.
- Let a user select scenarios and execute them against an explicitly configured base URL.
- Show each result as **PASS** or **FAIL**, with request/response details useful for diagnosis.
- Explain failed checks with evidence from the test result; AI analysis is advisory and does not change the result.

## Planned technology

- **Backend:** Python, FastAPI, Pydantic
- **HTTP execution:** HTTPX
- **Test and validation foundation:** Pytest and JSON Schema
- **AI:** provider-independent adapter, added after deterministic parsing and execution foundations
- **Frontend:** React / Next.js, considered after the backend workflow is validated

The first milestone is a small backend-led MVP. A web UI, accounts, hosted multi-user execution, CI/CD integrations, and advanced scoring are later decisions.

## Initial repository layout

```text
.
├── README.md
├── .gitignore
├── pyproject.toml
└── docs/
    └── MVP_ROADMAP.md
```

As implementation begins, the intended application structure is:

```text
backend/
├── app/
│   ├── api/          # FastAPI routes
│   ├── domain/       # API models and QA concepts
│   ├── services/     # OpenAPI analysis, scenario generation, execution
│   └── integrations/ # HTTP and AI provider adapters
└── tests/
```

## Getting started

The application is not implemented yet. Setup and run instructions will be added with the first working milestone.

## Roadmap

See [docs/MVP_ROADMAP.md](docs/MVP_ROADMAP.md) for the staged plan and product boundaries.

## Security and responsible use

- Run checks only against APIs you own or are authorized to test.
- Never commit credentials, API tokens, or private OpenAPI specifications.
- Configure the target host explicitly; generated scenarios should not silently send requests.
- Treat AI-generated scenarios and failure explanations as suggestions that need review.

## Project status

Early planning. This repository establishes the product direction and MVP scope; implementation comes next.
