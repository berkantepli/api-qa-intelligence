import { useEffect, useMemo, useState } from "react";
import ScenarioDraftEditor from "./ScenarioDraftEditor.jsx";
import { buildEditedScenario, createDraft, isEditedScenario, statusCodeSuggestions, validateDraft } from "./scenarioDraft.js";

const DEFAULT_TARGET_URL = "http://127.0.0.1:8000";
const STORAGE_KEYS = {
  theme: "api-qa-intelligence-theme",
  savedApis: "api-qa-intelligence-saved-apis",
  activeApi: "api-qa-intelligence-active-api",
  runHistory: "api-qa-intelligence-run-history",
};

const categoryLabels = {
  happy_path: "Happy path",
  negative: "Negative",
  boundary: "Boundary",
  invalid_value: "Invalid value",
  security_minded: "Security-minded",
};

function readStoredJson(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}

function isValidJson(value) {
  try { JSON.parse(value); return true; }
  catch { return false; }
}

async function postJson(url, body, fallbackMessage) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return readJsonResponse(response, fallbackMessage);
}

async function readJsonResponse(response, fallbackMessage) {
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.detail || fallbackMessage);
  return payload;
}

function runnableCheckCount(operation) {
  return operation.scenarios?.filter((scenario) => scenario.request_example).length ?? 0;
}

function firstRunnableOperationIndex(apiOverview) {
  const operations = apiOverview?.operations ?? [];
  const safeMethods = new Set(["GET", "HEAD", "OPTIONS"]);
  const hasRunnableCheck = (operation) => runnableCheckCount(operation) > 0;
  const readySafeIndex = operations.findIndex((operation) => safeMethods.has(operation.method)
    && hasRunnableCheck(operation)
    && (operation.parameters ?? []).every((parameter) => !parameter.required || parameter.example != null));
  if (readySafeIndex >= 0) return readySafeIndex;
  const safeIndex = operations.findIndex((operation) => safeMethods.has(operation.method) && hasRunnableCheck(operation));
  if (safeIndex >= 0) return safeIndex;
  const index = operations.findIndex(hasRunnableCheck);
  return index >= 0 ? index : 0;
}

function resolveApiTarget(api) {
  if (!api) return "";
  let sourceUrl;
  try { sourceUrl = new URL(api.source); } catch { sourceUrl = null; }
  const declaredServer = api.overview?.servers?.[0];
  if (declaredServer) {
    try { return new URL(declaredServer, sourceUrl || undefined).href.replace(/\/$/, ""); }
    catch { return ""; }
  }
  if (sourceUrl) {
    const savedTarget = api.targetUrl || "";
    let savedOrigin = "";
    try { savedOrigin = new URL(savedTarget).origin; } catch { /* saved value is not a URL */ }
    const defaultOrigin = new URL(DEFAULT_TARGET_URL).origin;
    if (savedTarget && !(savedOrigin === defaultOrigin && sourceUrl.origin !== defaultOrigin)) return savedTarget;
    const specPath = sourceUrl.pathname.toLowerCase();
    const inferred = specPath.endsWith("/openapi.json") ? new URL(".", sourceUrl).href : `${sourceUrl.origin}/`;
    return inferred.replace(/\/$/, "");
  }
  const savedTarget = api.targetUrl || "";
  try { return new URL(savedTarget).origin === new URL(DEFAULT_TARGET_URL).origin ? "" : savedTarget; }
  catch { return ""; }
}

function getRawBodyValue(inputs = {}, fallback) {
  if (Object.hasOwn(inputs, "body:__raw")) return inputs["body:__raw"];
  return fallback == null ? "" : JSON.stringify(fallback, null, 2);
}

function Icon({ name, size = 18, className }) {
  const common = {
    className,
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.8,
    strokeLinecap: "round",
    strokeLinejoin: "round",
    "aria-hidden": true,
  };
  const paths = {
    file: <><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" /><path d="M14 2v6h6M8 13h8M8 17h8" /></>,
    run: <><path d="m8 5 12 7-12 7z" /></>,
    upload: <><path d="M12 16V4m0 0L7 9m5-5 5 5" /><path d="M20 16.5v2A1.5 1.5 0 0 1 18.5 20h-13A1.5 1.5 0 0 1 4 18.5v-2" /></>,
    link: <><path d="M10 13a5 5 0 0 0 7.1 0l3-3A5 5 0 0 0 13 2.9l-1.7 1.7" /><path d="M14 11a5 5 0 0 0-7.1 0l-3 3A5 5 0 0 0 11 21.1l1.7-1.7" /></>,
    check: <path d="m5 12 4 4L19 6" />,
    shield: <><path d="M12 22s8-4 8-11V5l-8-3-8 3v6c0 7 8 11 8 11Z" /><path d="m9 12 2 2 4-4" /></>,
    spark: <><path d="m12 3 1.9 5.8L20 11l-6.1 2.2L12 19l-2-5.8L4 11l6-2.2L12 3Z" /><path d="m19 14 1 2.5 2.5 1-2.5 1L19 21l-1-2.5-2.5-1 2.5-1L19 14Z" /></>,
    chevron: <path d="m9 18 6-6-6-6" />,
    close: <><path d="m18 6-12 12M6 6l12 12" /></>,
    arrow: <><path d="M5 12h14" /><path d="m13 6 6 6-6 6" /></>,
    clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  };
  return <svg {...common}>{paths[name] || paths.file}</svg>;
}

function App() {
  const [theme, setTheme] = useState(() => localStorage.getItem(STORAGE_KEYS.theme) || "dark");
  const [savedApis, setSavedApis] = useState(() => readStoredJson(STORAGE_KEYS.savedApis, []));
  const [activeApiId, setActiveApiId] = useState(() => localStorage.getItem(STORAGE_KEYS.activeApi) || "");
  const overview = savedApis.find((api) => api.id === activeApiId)?.overview ?? null;
  const [page, setPage] = useState(() => savedApis.length ? "specs" : "import");
  const [runHistory, setRunHistory] = useState(() => readStoredJson(STORAGE_KEYS.runHistory, []));
  const [expandedRunId, setExpandedRunId] = useState(null);
  const [analysisState, setAnalysisState] = useState({});
  const [scenarioIdeaState, setScenarioIdeaState] = useState({});
  const [sourceMode, setSourceMode] = useState("url");
  const [specUrl, setSpecUrl] = useState("");
  const [file, setFile] = useState(null);
  const [selectedOperation, setSelectedOperation] = useState(() => firstRunnableOperationIndex(overview));
  const [selectedScenarios, setSelectedScenarios] = useState([]);
  // The one AI idea or edited check currently open in the editor: { scenarioIndex, draft }.
  const [editingDraft, setEditingDraft] = useState(null);
  const [showExecutionConfirmation, setShowExecutionConfirmation] = useState(false);
  const [results, setResults] = useState({});
  const [requestInputs, setRequestInputs] = useState({});
  const [requestFiles, setRequestFiles] = useState({});
  const [targetUrl, setTargetUrl] = useState(() => resolveApiTarget(savedApis.find((api) => api.id === activeApiId)) || DEFAULT_TARGET_URL);
  const [connectionStatus, setConnectionStatus] = useState("checking");
  const [connectionCheckId, setConnectionCheckId] = useState(0);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const operation = overview?.operations?.[selectedOperation];
  const isDataChangingMethod = ["POST", "PUT", "PATCH", "DELETE"].includes(operation?.method);
  const operationKey = operation ? `${operation.method} ${operation.path}` : "";
  const operationScenarios = operation?.scenarios ?? [];
  const aiScenarioIdeas = operationScenarios.map((scenario, scenarioIndex) => ({ scenario, scenarioIndex })).filter(({ scenario }) => scenario.source === "ai");
  const contractScenarios = operationScenarios.filter((scenario) => !isEditedScenario(scenario));
  const scenarioIdeaStatus = scenarioIdeaState[`${activeApiId}:${operationKey}`] ?? {};
  const operationInputs = requestInputs[operationKey] ?? {};
  const parameters = operation?.parameters ?? [];
  const pathParameters = [...(operation?.path?.matchAll(/\{([^}]+)\}/g) ?? [])].map((match) => match[1]);
  const knownParameterNames = new Set(parameters.filter((parameter) => parameter.location === "path").map((parameter) => parameter.name));
  const operationParameters = [
    ...parameters,
    ...pathParameters.filter((name) => !knownParameterNames.has(name)).map((name) => ({ name, location: "path", required: true })),
  ];
  const bodyFields = operation?.request_body_fields ?? [];
  const isFormBody = /^(multipart\/form-data|application\/x-www-form-urlencoded)/i.test(operation?.request_body_content_type || "");
  const fileFields = bodyFields.filter((field) => field.is_file);
  const sendsJsonBody = Boolean(operation?.request_body_content_type) && !isFormBody;
  const rawJsonFallback = contractScenarios.find((scenario) => scenario.request_example?.json_body != null)?.request_example?.json_body;
  const validBodyTemplate = contractScenarios.find((scenario) => scenario.category === "happy_path" && scenario.request_example?.json_body != null)?.request_example?.json_body
    ?? rawJsonFallback
    ?? {};
  const needsRawJsonBody = Boolean(operation?.request_body_required && !isFormBody && bodyFields.length === 0);
  const rawJsonBodyValue = getRawBodyValue(requestInputs[operationKey], rawJsonFallback);
  const rawJsonBodyIsValid = Boolean(rawJsonBodyValue.trim()) && isValidJson(rawJsonBodyValue);
  const getInputValue = (key, fallback = "") => Object.hasOwn(operationInputs, key) ? operationInputs[key] : fallback;
  const getParameterValue = (parameter) => getInputValue(`parameter:${parameter.location}:${parameter.name}`, parameter.example == null ? "" : String(parameter.example));
  const getBodyFieldValue = (field) => getInputValue(`body:${field.name}`, field.example == null ? "" : typeof field.example === "object" ? JSON.stringify(field.example) : String(field.example));
  const requiredParametersMissing = operationParameters.some((parameter) => parameter.required && !getParameterValue(parameter).trim());
  const hasInvalidJsonValue = (field) => !field.is_file && ["object", "array"].includes(field.field_type)
    && Boolean(getBodyFieldValue(field).trim()) && !isValidJson(getBodyFieldValue(field));
  const invalidStructuredBodyValue = bodyFields.some(hasInvalidJsonValue);
  const requiredBodyFieldsMissing = operation?.request_body_required && bodyFields.some((field) => field.required && (field.is_file
    ? !(requestFiles[operationKey]?.[field.name]?.length)
    : !getBodyFieldValue(field).trim()));
  const bodyReady = (!needsRawJsonBody || rawJsonBodyIsValid)
    && !(operation?.request_body_required && !isFormBody && bodyFields.some((field) => field.required && !getBodyFieldValue(field).trim()));
  const inputsReady = !requiredParametersMissing && !requiredBodyFieldsMissing && !invalidStructuredBodyValue && bodyReady;
  const scenarioTemplates = operationScenarios
    .map((scenario, scenarioIndex) => ({ ...scenario, scenarioIndex }))
    .filter((scenario) => scenario.request_example);
  const availableScenarios = inputsReady ? scenarioTemplates : [];
  const draftContext = { operation, parameters: operationParameters, bodyFields, sendsJsonBody, isFormBody };
  const draftProblems = editingDraft ? validateDraft(editingDraft.draft, draftContext) : [];
  const selectedCount = selectedScenarios.length;
  const methods = useMemo(() => new Set((overview?.operations ?? []).map((item) => item.method)), [overview]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    localStorage.setItem(STORAGE_KEYS.theme, theme);
  }, [theme]);

  useEffect(() => { localStorage.setItem(STORAGE_KEYS.savedApis, JSON.stringify(savedApis)); }, [savedApis]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.activeApi, activeApiId); }, [activeApiId]);
  useEffect(() => { localStorage.setItem(STORAGE_KEYS.runHistory, JSON.stringify(runHistory)); }, [runHistory]);

  useEffect(() => {
    if (!activeApiId || !targetUrl.trim()) {
      setConnectionStatus("unknown");
      return undefined;
    }
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 4000);
    setConnectionStatus("checking");
    fetch(targetUrl.trim(), { method: "HEAD", mode: "no-cors", cache: "no-store", signal: controller.signal })
      .then(() => setConnectionStatus("connected"))
      .catch(() => setConnectionStatus("unavailable"))
      .finally(() => window.clearTimeout(timeout));
    return () => { window.clearTimeout(timeout); controller.abort(); };
  }, [activeApiId, targetUrl, connectionCheckId]);

  function updateSavedApi(id, changes) {
    setSavedApis((current) => current.map((api) => api.id === id ? { ...api, ...changes } : api));
  }

  function resetRunState() {
    setSelectedScenarios([]);
    setShowExecutionConfirmation(false);
    setResults({});
    setEditingDraft(null);
  }

  function updateOperationScenarios(updateScenarios) {
    updateSavedApi(activeApiId, {
      overview: {
        ...overview,
        operations: overview.operations.map((item, index) => index === selectedOperation
          ? { ...item, scenarios: updateScenarios(item.scenarios) }
          : item),
      },
    });
  }

  // The body the user has prepared in the request details, used as the starting point for a draft.
  function currentJsonBody() {
    if (!sendsJsonBody) return null;
    if (needsRawJsonBody) return rawJsonBodyIsValid ? JSON.parse(rawJsonBodyValue) : rawJsonFallback ?? null;
    if (!validBodyTemplate || typeof validBodyTemplate !== "object" || Array.isArray(validBodyTemplate)) return validBodyTemplate;
    const body = { ...validBodyTemplate };
    for (const field of bodyFields) {
      const value = getBodyFieldValue(field);
      if (field.is_file || !value.trim()) continue;
      try { body[field.name] = JSON.parse(value); }
      catch { body[field.name] = value; }
    }
    return body;
  }

  function openDraftEditor(scenarioIndex) {
    const scenario = operationScenarios[scenarioIndex];
    const initialFormFields = Object.fromEntries(bodyFields.filter((field) => !field.is_file).map((field) => [field.name, getBodyFieldValue(field)]));
    setShowExecutionConfirmation(false);
    setEditingDraft({ scenarioIndex, draft: createDraft(scenario, { ...draftContext, initialJsonBody: currentJsonBody(), initialFormFields }) });
  }

  function saveDraft() {
    if (!editingDraft || draftProblems.length) return;
    const check = buildEditedScenario(editingDraft.draft, draftContext);
    updateOperationScenarios((scenarios) => scenarios.map((scenario, index) => index === editingDraft.scenarioIndex ? check : scenario));
    resetRunState();
  }

  function removeEditedCheck(scenarioIndex) {
    updateOperationScenarios((scenarios) => scenarios.filter((_, index) => index !== scenarioIndex));
    resetRunState();
  }

  function updateTargetUrl(value) {
    setTargetUrl(value);
    updateSavedApi(activeApiId, { targetUrl: value });
  }

  async function importSpec(event) {
    event?.preventDefault();
    setLoading(true);
    setError("");
    setNotice("");
    try {
      const failureMessage = "The specification could not be imported.";
      let payload;
      if (sourceMode === "url") {
        payload = await postJson("/api/v1/specs/import-url", { url: specUrl }, failureMessage);
      } else {
        if (!file) throw new Error("Choose an OpenAPI JSON or YAML file first.");
        const data = new FormData();
        data.append("file", file);
        payload = await readJsonResponse(await fetch("/api/v1/specs/import", { method: "POST", body: data }), failureMessage);
      }
      const source = sourceMode === "url" ? specUrl : file.name;
      const id = `${payload.title || "API"}::${source}`;
      const importedTargetUrl = resolveApiTarget({ source, overview: payload });
      const savedApi = { id, title: payload.title || "Imported API", source, importedAt: new Date().toISOString(), overview: payload, targetUrl: importedTargetUrl };
      setSavedApis((current) => [savedApi, ...current.filter((api) => api.id !== id)]);
      setActiveApiId(id);
      setTargetUrl(importedTargetUrl);
      setPage("overview");
      setSelectedOperation(firstRunnableOperationIndex(payload));
      resetRunState();
      setNotice(`Imported ${payload.operation_count} operations. Review the suggested scenarios below.`);
    } catch (caught) {
      setError(caught.message || "Something went wrong while importing the specification.");
    } finally {
      setLoading(false);
    }
  }

  function selectOperation(index) {
    setSelectedOperation(index);
    resetRunState();
  }

  async function generateScenarioIdeas() {
    if (!operation || !activeApiId) return;
    const key = `${activeApiId}:${operationKey}`;
    setScenarioIdeaState((current) => ({ ...current, [key]: { loading: true, error: "" } }));
    try {
      const payload = await postJson("/api/v1/specs/scenario-ideas", { operation }, "AI scenario suggestions could not be generated.");
      // Saved edited checks stay; only unconverted ideas are replaced.
      updateOperationScenarios((scenarios) => [...scenarios.filter((scenario) => scenario.source !== "ai"), ...(payload.scenarios ?? [])]);
      resetRunState();
      setScenarioIdeaState((current) => ({ ...current, [key]: { loading: false, error: "" } }));
    } catch (caught) {
      setScenarioIdeaState((current) => ({ ...current, [key]: { loading: false, error: caught.message || "AI scenario suggestions could not be generated." } }));
    }
  }

  function toggleScenario(index) {
    setShowExecutionConfirmation(false);
    setSelectedScenarios((current) => current.includes(index)
      ? current.filter((item) => item !== index)
      : [...current, index]);
  }

  function updateRequestInput(name, value) {
    setRequestInputs((current) => ({
      ...current,
      [operationKey]: { ...(current[operationKey] ?? {}), [name]: value },
    }));
  }

  function updateRequestFiles(name, files) {
    setRequestFiles((current) => ({
      ...current,
      [operationKey]: { ...(current[operationKey] ?? {}), [name]: files },
    }));
  }

  async function runSelected() {
    if (!operation || !inputsReady || selectedCount === 0) return;
    setRunning(true);
    setError("");
    const nextResults = { ...results };
    const completed = [];
    try {
      for (const index of selectedScenarios) {
        const scenario = availableScenarios[index];
        const example = scenario.request_example;
        if (!example) continue;
        const isEditedCheck = isEditedScenario(scenario);
        const omittedParameters = new Set((example.omitted_parameters ?? []).map((parameter) => `${parameter.location}:${parameter.name}`));
        const parameterValue = (parameter) => example.parameter_values?.[`${parameter.location}:${parameter.name}`] ?? getParameterValue(parameter);
        const path = operation.path.replace(/\{([^}]+)\}/g, (_, name) => omittedParameters.has(`path:${name}`) ? "" : encodeURIComponent(parameterValue({ location: "path", name })));
        const queryParams = { ...example.query_params };
        const headers = {};
        const cookieValues = [];
        for (const parameter of operationParameters) {
          if (omittedParameters.has(`${parameter.location}:${parameter.name}`)) continue;
          const value = parameterValue(parameter).trim();
          if (!value) continue;
          if (parameter.location === "query") queryParams[parameter.name] = value;
          if (parameter.location === "header") headers[parameter.name] = value;
          if (parameter.location === "cookie") cookieValues.push(`${parameter.name}=${encodeURIComponent(value)}`);
        }
        if (cookieValues.length) headers.Cookie = cookieValues.join("; ");
        const formFields = { ...example.form_fields };
        // Edited AI checks send the body exactly as the user wrote it in the editor.
        const jsonBody = isEditedCheck
          ? example.json_body ?? null
          : needsRawJsonBody
          ? JSON.parse(rawJsonBodyValue)
          : example.json_body && typeof example.json_body === "object" && !Array.isArray(example.json_body)
            ? { ...example.json_body }
            : example.json_body ?? (bodyFields.length ? {} : null);
        for (const field of bodyFields) {
          const value = getBodyFieldValue(field);
          if (field.is_file || isEditedCheck) continue;
          if (isFormBody) formFields[field.name] = value;
          else if (jsonBody && typeof jsonBody === "object" && Object.hasOwn(jsonBody, field.name)) {
            const validValue = validBodyTemplate?.[field.name];
            const scenarioValue = example.json_body?.[field.name];
            if (JSON.stringify(scenarioValue) === JSON.stringify(validValue)) {
              if (!value.trim() && field.example == null) delete jsonBody[field.name];
              else {
                try { jsonBody[field.name] = JSON.parse(value); }
                catch { jsonBody[field.name] = value; }
              }
            }
          }
        }
        const fileUploads = {};
        for (const field of fileFields) {
          const files = requestFiles[operationKey]?.[field.name] ?? [];
          if (files.length) fileUploads[field.name] = await Promise.all(files.map(async (fileItem) => {
            const bytes = new Uint8Array(await fileItem.arrayBuffer());
            let binary = "";
            for (let offset = 0; offset < bytes.length; offset += 0x8000) {
              binary += String.fromCharCode(...bytes.subarray(offset, Math.min(offset + 0x8000, bytes.length)));
            }
            return { filename: fileItem.name, content_type: fileItem.type || "application/octet-stream", content_base64: btoa(binary) };
          }));
        }
        const result = await postJson(
          "/api/v1/runs/execute",
          {
            method: example.method,
            path,
            query_params: queryParams,
            headers,
            form_body: example.form_body,
            form_fields: formFields,
            file_uploads: fileUploads,
            json_body: jsonBody,
            expected_status_codes: example.expected_status_codes,
            base_url: targetUrl,
          },
          "The check could not be executed.",
        );
        nextResults[index] = result;
        completed.push({ title: scenario.title, category: scenario.category, source: scenario.source, ...result });
        setResults({ ...nextResults });
      }
      if (completed.length) {
        const entry = { id: Date.now(), api: overview.title, endpoint: `${operation.method} ${operation.path}`, target: targetUrl, createdAt: new Date().toISOString(), results: completed };
        setRunHistory((current) => [entry, ...current]);
      }
    } catch (caught) {
      setError(caught.message || "The checks could not be completed.");
    } finally {
      setRunning(false);
    }
  }

  async function analyzeFailure(runId, resultIndex, result) {
    const key = `${runId}:${resultIndex}`;
    setAnalysisState((current) => ({ ...current, [key]: { loading: true, error: "" } }));
    try {
      const payload = await postJson(
        "/api/v1/runs/analyze-failure",
        { ...result, result: "FAIL", scenario_title: result.title || `Check ${resultIndex + 1}` },
        "AI analysis could not be completed.",
      );
      setRunHistory((current) => current.map((run) => run.id === runId
        ? { ...run, results: run.results.map((item, index) => index === resultIndex ? { ...item, analysis: payload } : item) }
        : run));
    } catch (caught) {
      setAnalysisState((current) => ({ ...current, [key]: { loading: false, error: caught.message || "AI analysis could not be completed." } }));
      return;
    }
    setAnalysisState((current) => ({ ...current, [key]: { loading: false, error: "" } }));
  }

  function requestRun() {
    if (!operation || !inputsReady || selectedCount === 0 || running) return;
    if (isDataChangingMethod) {
      setShowExecutionConfirmation(true);
      return;
    }
    runSelected();
  }

  function confirmRun() {
    setShowExecutionConfirmation(false);
    runSelected();
  }

  function openSavedApi(api) {
    const resolvedTargetUrl = resolveApiTarget(api);
    setTargetUrl(resolvedTargetUrl);
    if (resolvedTargetUrl !== (api.targetUrl || "")) updateSavedApi(api.id, { targetUrl: resolvedTargetUrl });
    setActiveApiId(api.id);
    setSelectedOperation(firstRunnableOperationIndex(api.overview));
    resetRunState();
    setPage("overview");
  }

  function openImportPage() {
    setError("");
    setNotice("");
    setSpecUrl("");
    setFile(null);
    setSourceMode("url");
    setPage("import");
  }

  function openSpecsPage() {
    setPage("specs");
  }

  const draftEditor = editingDraft && <ScenarioDraftEditor
    draft={editingDraft.draft}
    problems={draftProblems}
    parameters={operationParameters}
    sendsJsonBody={sendsJsonBody}
    isFormBody={isFormBody}
    statusSuggestions={statusCodeSuggestions(operationScenarios)}
    isDataChangingMethod={isDataChangingMethod}
    saveLabel={isEditedScenario(operationScenarios[editingDraft.scenarioIndex]) ? "Save changes" : "Save as check"}
    onChange={(draft) => setEditingDraft((current) => ({ ...current, draft }))}
    onCancel={() => setEditingDraft(null)}
    onSave={saveDraft}
  />;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={openSpecsPage} aria-label="API QA Intelligence home">
          <svg className="brand-mark" viewBox="0 0 64 64" role="img" aria-label="API Hub logo">
            <path className="brand-link brand-link-blue" d="M32 15v12" />
            <path className="brand-link brand-link-violet" d="M19 39l8-5" />
            <path className="brand-link brand-link-green" d="M45 39l-8-5" />
            <circle className="brand-node brand-node-blue" cx="32" cy="12" r="10" />
            <circle className="brand-node-core" cx="32" cy="12" r="4" />
            <circle className="brand-node brand-node-violet" cx="15" cy="42" r="10" />
            <circle className="brand-node-core" cx="15" cy="42" r="4" />
            <circle className="brand-node brand-node-center" cx="32" cy="32" r="8" />
            <circle className="brand-node brand-node-green" cx="49" cy="42" r="10" />
            <path className="brand-check" d="m44.5 42 3 3 6-6" />
          </svg>
          <span>API QA <b>Intelligence</b></span>
        </button>
        <div className="nav-section-label">WORKSPACE</div>
        <button className={`nav-link ${page === "specs" ? "active" : ""}`} onClick={openSpecsPage}>
          <Icon name="file" /><span>API specs</span>
        </button>
        <button className={`nav-link ${page === "history" ? "active" : ""}`} onClick={() => setPage("history")}>
          <Icon name="clock" /><span>Run history</span>
        </button>
      </aside>

      <main className="main-area">
        <header className="topbar">
          {savedApis.length && page !== "import" ? <div className="api-context">
            <label className="api-context-picker"><span>ACTIVE API</span><select aria-label="Active API" value={activeApiId} onChange={(event) => {
              const selectedApi = savedApis.find((api) => api.id === event.target.value);
              if (selectedApi) openSavedApi(selectedApi);
            }}>{savedApis.map((api) => <option key={api.id} value={api.id}>{api.title}</option>)}</select></label>
            <button className={`connection-status connection-${connectionStatus}`} type="button" onClick={() => setConnectionCheckId((current) => current + 1)} disabled={connectionStatus === "checking"} title={`Check ${targetUrl}`}>
              <span className="connection-dot" aria-hidden="true" />
              {connectionStatus === "checking" ? "Checking connection" : connectionStatus === "connected" ? "API reachable" : connectionStatus === "unavailable" ? "API unavailable · retry" : "No API selected"}
            </button>
          </div> : <nav className="breadcrumbs" aria-label="Current page"><strong>{page === "history" ? "Run history" : page === "import" ? "Import API" : "API specs"}</strong></nav>}
          <div className="topbar-right"><button className="theme-switch" type="button" onClick={() => setTheme((current) => current === "dark" ? "light" : "dark")} aria-label={`Switch to ${theme === "dark" ? "light" : "dark"} mode`} aria-pressed={theme === "light"} title={`Switch to ${theme === "dark" ? "light" : "dark"} mode`}><span className="theme-switch-track"><svg className="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M4.93 4.93l1.41 1.41m11.32 11.32 1.41 1.41M2 12h2m16 0h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" /></svg><svg className="theme-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M21 12.8A8.5 8.5 0 1 1 11.2 3 6.7 6.7 0 0 0 21 12.8Z" /></svg></span><span className="theme-knob" /></button></div>
        </header>

        {page === "history" ? (
          <section className="history-page">
            <div className="page-eyebrow">TEST EXECUTIONS</div>
            <h1>Run history</h1>
            <p className="page-lede">Review the checks you have run in this browser.</p>
            {runHistory.length ? <div className="history-list">{runHistory.map((run) => {
              const passed = run.results.filter((result) => result.result === "PASS").length;
              const failed = run.results.length - passed;
              const expanded = expandedRunId === run.id;
              return <article className="history-card" key={run.id}>
                <button className="history-card-toggle" type="button" aria-expanded={expanded} onClick={() => setExpandedRunId(expanded ? null : run.id)}>
                  <div className="history-card-heading"><div><strong>{run.api}</strong><span>{run.endpoint}</span></div><time>{new Date(run.createdAt).toLocaleString()}</time><Icon className={`history-chevron ${expanded ? "expanded" : ""}`} name="chevron" size={17} /></div>
                  <div className="history-card-footer"><span>{run.results.length} checks · <i className="history-pass">{passed} passed</i> · <i className="history-fail">{failed} failed</i></span><span className="history-target">Target: {run.target}</span></div>
                  <span className="history-view-label">{expanded ? "Hide details" : "View check details"}</span>
                </button>
                {expanded && <div className="history-details">{run.results.map((result, index) => {
                  const analysis = analysisState[`${run.id}:${index}`] ?? {};
                  return <section className="history-result" key={`${result.title || "check"}-${index}`}>
                  <div className="history-result-heading"><span className={`history-status status-${String(result.result || "error").toLowerCase()}`}>{result.result || "ERROR"}</span><strong>{result.title || `Check ${index + 1}`}</strong>{isEditedScenario(result) && <span className="edited-pill">AI idea · edited</span>}{result.response_status && <span>HTTP {result.response_status}</span>}{result.duration_ms != null && <span>{result.duration_ms} ms</span>}</div>
                  {result.error && <p className="history-error">{result.error}</p>}
                  {(result.request_url || result.request_headers || result.request_body) && <details className="history-response"><summary>Request evidence</summary><pre>{JSON.stringify({ url: result.request_url, headers: result.request_headers, body: result.request_body || undefined }, null, 2)}</pre></details>}
                  {(result.response_status || result.response_headers || result.response_body) && <details className="history-response"><summary>Response evidence</summary><pre>{JSON.stringify({ status: result.response_status, headers: result.response_headers, body: result.response_body || undefined, truncated: result.response_truncated || undefined }, null, 2)}</pre></details>}
                  {result.result === "FAIL" && !result.analysis && <div className="failure-analysis-action"><button className="secondary-button" type="button" disabled={analysis.loading} onClick={() => analyzeFailure(run.id, index, result)}><Icon name="spark" size={14} />{analysis.loading ? "Analyzing with AI…" : "Analyze with AI"}</button><span>Credential-like values are redacted. Clicking sends this check’s evidence to your configured Ollama model.</span></div>}
                  {analysis.error && <p className="history-error">{analysis.error}</p>}
                  {result.analysis && <div className="failure-analysis"><div className="failure-analysis-title"><Icon name="spark" size={15} /><strong>AI failure analysis</strong><span>Advisory</span></div><p>{result.analysis.summary}</p>{result.analysis.likely_causes?.length > 0 && <div><strong>Possible causes</strong><ul>{result.analysis.likely_causes.map((cause, causeIndex) => <li key={causeIndex}><b>{cause.cause}</b><span>{cause.evidence} · Confidence: {cause.confidence}</span></li>)}</ul></div>}{result.analysis.next_steps?.length > 0 && <div><strong>Suggested next steps</strong><ul>{result.analysis.next_steps.map((step, stepIndex) => <li key={stepIndex}>{step}</li>)}</ul></div>}<small>{result.analysis.limitations}</small></div>}
                  </section>;
                })}</div>}
              </article>;
            })}</div> : <div className="history-empty"><Icon name="clock" size={25} /><strong>No runs yet</strong><span>Run selected checks from an API overview and they will appear here.</span><button className="secondary-button" onClick={openSpecsPage}>Go to API specs</button></div>}
          </section>
        ) : page === "specs" ? (
          <section className="specs-page">
            <div className="specs-heading"><div><div className="page-eyebrow">YOUR API QA WORKSPACE</div><h1>API specs</h1><p className="page-lede">Your imported APIs stay here so you can return to them anytime.</p></div><button className="primary-button" onClick={openImportPage}><Icon name="upload" size={15} /> Import API</button></div>
            {savedApis.length ? <div className="specs-list">{savedApis.map((api) => <button className="spec-card" key={api.id} onClick={() => openSavedApi(api)}><span className="spec-card-icon"><Icon name="file" size={19} /></span><span className="spec-card-copy"><strong>{api.title}</strong><small>Version {api.overview.version} · OpenAPI {api.overview.openapi_version}</small><small>{api.overview.operation_count} endpoints · Imported {new Date(api.importedAt).toLocaleDateString()}</small></span><Icon name="chevron" size={18} /></button>)}</div> : <div className="history-empty"><Icon name="file" size={25} /><strong>No API specs yet</strong><span>Import an OpenAPI specification and it will be saved here.</span><button className="primary-button" onClick={openImportPage}><Icon name="upload" size={15} /> Import API</button></div>}
          </section>
        ) : page === "import" || !overview ? (
          <section className="setup-page">
            <div className="page-eyebrow">YOUR API QA WORKSPACE</div>
            <h1>Start with an API contract</h1>
            <p className="page-lede">Import an OpenAPI spec to understand your endpoints and get a first set of QA scenarios.</p>
            <form className="import-card" onSubmit={importSpec}>
              <div className="card-heading">
                <span className="card-icon"><Icon name="file" size={20} /></span>
                <div><h2>Import OpenAPI specification</h2><p>Use a spec URL or choose a local JSON/YAML file.</p></div>
              </div>
              <div className="mode-switch" role="tablist" aria-label="Specification source">
                <button type="button" role="tab" aria-selected={sourceMode === "url"} className={sourceMode === "url" ? "selected" : ""} onClick={() => setSourceMode("url")}><Icon name="link" size={16} /> Spec URL</button>
                <button type="button" role="tab" aria-selected={sourceMode === "file"} className={sourceMode === "file" ? "selected" : ""} onClick={() => setSourceMode("file")}><Icon name="upload" size={16} /> Upload file</button>
              </div>
              {sourceMode === "url" ? (
                <label className="field-wrap"><span className="field-label">OpenAPI URL</span><span className="input-with-icon"><Icon name="link" size={17} /><input autoComplete="url" type="url" value={specUrl} onChange={(event) => setSpecUrl(event.target.value)} placeholder="https://api.example.com/openapi.json" required /></span></label>
              ) : (
                <label className="upload-box"><span className="upload-icon"><Icon name="upload" size={21} /></span><strong>{file ? file.name : "Choose an OpenAPI file"}</strong><small>JSON or YAML · OpenAPI 3.x</small><input type="file" accept=".json,.yaml,.yml,application/json,text/yaml" onChange={(event) => setFile(event.target.files?.[0] || null)} required /></label>
              )}
              {error && <div className="alert error-alert" role="alert"><Icon name="close" size={17} />{error}</div>}
              {notice && <div className="alert success-alert" role="status"><Icon name="check" size={17} />{notice}</div>}
              <div className="card-footer"><span className="privacy-note"><Icon name="shield" size={16} /> Import only reads the API contract</span><button className="primary-button" type="submit" disabled={loading}>{loading ? <><span className="spinner" /> Importing…</> : <>Import API <Icon name="arrow" size={16} /></>}</button></div>
            </form>
            <div className="workflow-strip">
              <div className="workflow-step"><span>1</span><div><strong>Understand the API</strong><small>Inspect endpoints and schemas</small></div></div>
              <div className="workflow-line" />
              <div className="workflow-step"><span>2</span><div><strong>Review QA scenarios</strong><small>See what is worth testing</small></div></div>
              <div className="workflow-line" />
              <div className="workflow-step"><span>3</span><div><strong>Run selected checks</strong><small>Choose a target and review results</small></div></div>
            </div>
          </section>
        ) : (
          <section className="overview-page">
            <div className="overview-heading">
              <div><div className="page-eyebrow">API OVERVIEW</div><h1>{overview.title}</h1><p className="page-lede">Version {overview.version} <span className="dot-sep">·</span> OpenAPI {overview.openapi_version}</p></div>
            </div>
            <div className="stats-row">
              <div className="stat-card"><span className="stat-label">Endpoints</span><strong>{overview.operation_count}</strong><span className="stat-note">available to review</span></div>
              <div className="stat-card"><span className="stat-label">Methods</span><strong className="method-stat">{[...methods].join(" · ") || "—"}</strong><span className="stat-note">found in this API</span></div>
              <div className="stat-card"><span className="stat-label">Runnable checks</span><strong>{overview.operations.reduce((sum, item) => sum + runnableCheckCount(item), 0)}</strong><span className="stat-note">ready to execute</span></div>
            </div>
            <div className="workspace-grid">
              <section className="panel endpoints-panel">
                <div className="panel-header"><div><h2>Endpoints</h2><p>Select an endpoint to review its scenarios.</p></div><span className="count-pill">{overview.operation_count}</span></div>
                <div className="endpoint-list">
                  {overview.operations.map((item, index) => (
                    <button key={`${item.method}-${item.path}-${index}`} className={`endpoint-row ${selectedOperation === index ? "selected" : ""}`} onClick={() => selectOperation(index)}>
                      <span className={`method-tag method-${item.method.toLowerCase()}`}>{item.method}</span>
                      <span className="endpoint-copy"><strong>{item.path}</strong><small>{item.summary || item.operation_id || item.tags?.[0] || "API endpoint"}</small></span>
                      <span className="scenario-count">{runnableCheckCount(item)}<span>checks</span></span>
                    </button>
                  ))}
                </div>
              </section>
              <section className="panel scenario-panel">
                <div className="panel-header scenario-header"><div><div className="panel-kicker"><Icon name="spark" size={15} /> RUNNABLE CHECKS {isDataChangingMethod && <span className="mutation-badge">May change data</span>}</div><h2>{operation?.method} <span>{operation?.path}</span></h2><p>These checks include a complete request and can be executed now.</p></div></div>
                <label className="target-field"><span>Target API base URL</span><input value={targetUrl} onChange={(event) => updateTargetUrl(event.target.value)} placeholder="http://127.0.0.1:8000" /></label>
                {(operationParameters.length > 0 || bodyFields.length > 0 || needsRawJsonBody) && <div className="request-inputs">
                  <div className="request-inputs-heading"><strong>Request details</strong><span>Fill in required values from your test environment.</span></div>
                  {operationParameters.map((parameter) => <label className="request-input" key={`${parameter.location}:${parameter.name}`}>
                    <span>{parameter.name}<small>{parameter.location}{parameter.required ? " · required" : " · optional"}</small></span>
                    <input type={parameter.location === "header" ? "password" : "text"} value={getParameterValue(parameter)} onChange={(event) => updateRequestInput(`parameter:${parameter.location}:${parameter.name}`, event.target.value)} placeholder={parameter.example == null ? `Enter ${parameter.name}` : String(parameter.example)} />
                    {parameter.description && <small className="request-input-help">{parameter.description}</small>}
                  </label>)}
                  {bodyFields.map((field) => <label className="request-input" key={`body:${field.name}`}>
                    <span>{field.name}<small>{field.is_file ? (field.multiple ? "file · multiple" : "file") : `${isFormBody ? "form field" : "request body"}${field.required ? " · required" : " · optional"}`}</small></span>
                    {field.is_file ? <><input type="file" multiple={field.multiple} onChange={(event) => updateRequestFiles(field.name, Array.from(event.target.files ?? []))} /><small className="request-input-help">{requestFiles[operationKey]?.[field.name]?.map((item) => item.name).join(", ") || (field.required ? "Choose a file to run this check." : "Optional file upload.")}</small></> : field.field_type === "object" || field.field_type === "array" ? <textarea rows="3" value={getBodyFieldValue(field)} onChange={(event) => updateRequestInput(`body:${field.name}`, event.target.value)} placeholder={`Enter ${field.name}${field.required ? " (required)" : ""}`} /> : <input type="text" value={getBodyFieldValue(field)} onChange={(event) => updateRequestInput(`body:${field.name}`, event.target.value)} placeholder={field.example == null ? `Enter ${field.name}${field.required ? " (required)" : ""}` : String(field.example)} />}
                    {field.description && <small className="request-input-help">{field.description}</small>}
                    {hasInvalidJsonValue(field) && <small className="request-input-help request-input-error">Enter valid JSON for this field.</small>}
                  </label>)}
                  {needsRawJsonBody && <label className="request-input"><span>Request body JSON<small>required</small></span><textarea rows="6" value={rawJsonBodyValue} onChange={(event) => updateRequestInput("body:__raw", event.target.value)} placeholder="Enter a complete JSON request body" />{rawJsonBodyValue.trim() && !rawJsonBodyIsValid && <small className="request-input-help request-input-error">Enter valid JSON before running checks.</small>}</label>}
                </div>}
                <div className="scenario-list">
                  {availableScenarios.map((scenario, index) => {
                    const result = results[index];
                    const checked = selectedScenarios.includes(index);
                    return (
                      <article key={`${scenario.category}-${scenario.title}-${index}`} className={`scenario-card ${checked ? "checked" : ""}`}>
                        <label className="scenario-select">
                          <input type="checkbox" checked={checked} disabled={running} onChange={() => toggleScenario(index)} />
                          <span className="custom-check"><Icon name="check" size={13} /></span>
                        </label>
                        <div className="scenario-content"><div className="scenario-title-row"><span className={`category-pill category-${scenario.category}`}>{categoryLabels[scenario.category] || scenario.category}</span>{isEditedScenario(scenario) && <span className="edited-pill">AI idea · edited</span>}</div><h3>{scenario.title}</h3><p>{scenario.rationale}</p>
                        {isEditedScenario(scenario) && <p className="edited-check-summary">Expects HTTP {scenario.request_example.expected_status_codes.join(", ")}{scenario.request_example.omitted_parameters?.length ? ` · omits ${scenario.request_example.omitted_parameters.map((parameter) => parameter.name).join(", ")}` : ""}</p>}
                        {isEditedScenario(scenario) && editingDraft?.scenarioIndex !== scenario.scenarioIndex && <div className="card-actions"><button className="text-button" type="button" disabled={running} onClick={() => openDraftEditor(scenario.scenarioIndex)}>Edit</button><button className="text-button danger" type="button" disabled={running} onClick={() => removeEditedCheck(scenario.scenarioIndex)}>Remove</button></div>}
                        {editingDraft?.scenarioIndex === scenario.scenarioIndex && draftEditor}
                        {result && <div className={`result-box result-${result.result.toLowerCase()}`}><div className="result-heading"><strong>{result.result}</strong>{result.response_status && <span>HTTP {result.response_status}</span>}<small>{result.duration_ms} ms</small></div>{result.error && <p>{result.error}</p>}{result.response_body && <details><summary>Response details</summary><pre>{result.response_body}</pre></details>}</div>}</div>
                      </article>
                    );
                  })}
                  {!inputsReady ? <div className="empty-state">Complete the required request details above to prepare these checks.</div> : availableScenarios.length === 0 && <div className="empty-state">No executable checks are available for this endpoint yet. Choose another endpoint with a complete request example.</div>}
                </div>
                <section className="ai-suggestions">
                  <div className="ai-suggestions-heading"><div><div className="panel-kicker"><Icon name="spark" size={14} /> AI SUGGESTIONS</div><p>Ideas based on this endpoint’s contract. Review them before turning them into checks.</p></div><button className="secondary-button" type="button" disabled={scenarioIdeaStatus.loading} onClick={generateScenarioIdeas}>{scenarioIdeaStatus.loading ? <><span className="spinner" /> Thinking…</> : <><Icon name="spark" size={14} /> {aiScenarioIdeas.length ? "Refresh suggestions" : "Suggest scenarios"}</>}</button></div>
                  <small className="ai-suggestions-note">Sends endpoint details to your configured AI model. No credentials or API requests are sent.</small>
                  {scenarioIdeaStatus.error && <div className="alert error-alert" role="alert">{scenarioIdeaStatus.error}</div>}
                  {aiScenarioIdeas.length ? <div className="ai-suggestions-list">{aiScenarioIdeas.map(({ scenario, scenarioIndex }) => <article className="ai-suggestion-card" key={`${scenario.title}-${scenarioIndex}`}>
                    <div className="scenario-title-row"><span className={`category-pill category-${scenario.category}`}>{categoryLabels[scenario.category] || scenario.category}</span><span className="review-pill">Review · not runnable</span></div>
                    <h3>{scenario.title}</h3><p>{scenario.rationale}</p>
                    {editingDraft?.scenarioIndex === scenarioIndex
                      ? draftEditor
                      : <div className="card-actions"><button className="text-button" type="button" disabled={running} onClick={() => openDraftEditor(scenarioIndex)}>Convert to check</button></div>}
                  </article>)}</div> : <div className="ai-suggestions-empty">No AI ideas yet. Generate suggestions when you want a second QA perspective.</div>}
                </section>
                {showExecutionConfirmation && <div className="execution-confirmation" role="alert">
                  <div><strong>This request may change data.</strong><p>You are about to run {selectedCount} {operation.method} {operation.path} check{selectedCount === 1 ? "" : "s"} against {targetUrl}. This can create, update, or delete data in the target API.</p></div>
                  <div className="execution-confirmation-actions"><button className="secondary-button" type="button" onClick={() => setShowExecutionConfirmation(false)}>Cancel</button><button className="primary-button" type="button" onClick={confirmRun}>Confirm and run</button></div>
                </div>}
                <div className="run-footer"><span>{inputsReady ? `${availableScenarios.length} ${availableScenarios.length === 1 ? "check" : "checks"} ready to run` : "Complete required request details first"}</span><button className="primary-button" disabled={!inputsReady || selectedCount === 0 || running} onClick={requestRun}>{running ? <><span className="spinner" /> Running…</> : <><Icon name="run" size={15} /> Run selected{selectedCount ? ` (${selectedCount})` : ""}</>}</button></div>
                {error && <div className="alert error-alert run-error" role="alert"><Icon name="close" size={17} />{error}</div>}
              </section>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

export default App;
