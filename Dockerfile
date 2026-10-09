# API QA Intelligence: the web app and backend in one image.
#   docker build -t api-qa-intelligence .
#   docker run -p 8001:8001 -v api-qa-data:/data api-qa-intelligence
# Then open http://localhost:8001. The image also contains the `api-qa` CLI.

FROM node:22-slim AS web
WORKDIR /app
COPY VERSION ./
COPY frontend/package.json frontend/package-lock.json frontend/
RUN cd frontend && npm ci --no-audit --no-fund
COPY frontend frontend
RUN cd frontend && npm run build

FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    API_QA_DATA_DIR=/data \
    OLLAMA_BASE_URL=http://host.docker.internal:11434
WORKDIR /app
COPY pyproject.toml README.md VERSION ./
COPY backend backend
RUN pip install --no-cache-dir . && rm -rf build
COPY --from=web /app/frontend/dist frontend/dist
RUN useradd --create-home --uid 10001 app && mkdir /data && chown app /data
USER app
VOLUME /data
EXPOSE 8001
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8001/health')"
CMD ["uvicorn", "app.main:app", "--app-dir", "backend", "--host", "0.0.0.0", "--port", "8001"]
