import { useRef, useState } from "react";
import Icon from "./Icon.jsx";

// tone drives the dot color; text is the short label; detail explains it (sidebar tooltip).
export function aiStatusLabel(aiStatus) {
  if (!aiStatus || aiStatus.loading) return { tone: "checking", text: "Checking AI model", detail: "Checking the intelligence service…" };
  if (aiStatus.error) return { tone: "unavailable", text: "AI model unavailable", detail: aiStatus.error };
  if (!aiStatus.reachable) return { tone: "unavailable", text: "AI model unavailable", detail: `Ollama is not reachable at ${aiStatus.base_url}` };
  if (!aiStatus.model_available) return { tone: "warning", text: "Model not installed", detail: `${aiStatus.model} is not installed in Ollama` };
  return { tone: "connected", text: "AI model ready", detail: `${aiStatus.model} is ready` };
}

const diagnosisSteps = [
  { key: "application", label: "Application" },
  { key: "ollama", label: "Ollama server" },
  { key: "model_check", label: "Required model" },
  { key: "inference", label: "Inference test" },
];
const stepIcons = { available: "check", unavailable: "close", skipped: "minus" };

// Renders `backticked` fragments of a diagnosis message as inline code.
function DiagnosisText({ text }) {
  return text.split(/(`[^`]+`)/).map((part, index) => part.startsWith("`") && part.endsWith("`")
    ? <code key={index}>{part.slice(1, -1)}</code>
    : part);
}

function AiDiagnosis({ diagnosis }) {
  const { loading, result, error, checkedAt } = diagnosis;
  const summary = loading
    ? "Running… the test prompt can take up to a minute while the model loads."
    : error || `${result.available ? "All checks passed" : "A problem was found"} · ${new Date(checkedAt).toLocaleTimeString()}`;
  return <div className="diagnosis" aria-live="polite">
    <div className="diagnosis-heading">
      <strong>Diagnosis</strong>
      <span className={!loading && result ? (result.available ? "history-pass" : "history-fail") : undefined}>{loading && <span className="spinner" />}{summary}</span>
    </div>
    {result && !loading && <ol className="diagnosis-steps">{diagnosisSteps.map(({ key, label }) => {
      const step = result[key];
      return <li key={key} className={`diagnosis-step diagnosis-${step.status}`}>
        <span className="diagnosis-icon"><Icon name={stepIcons[step.status]} size={13} /></span>
        <div>
          <strong>{label}</strong>
          <p><DiagnosisText text={step.reason} /></p>
          {step.suggested_action && <p className="diagnosis-action">Suggested: <DiagnosisText text={step.suggested_action} /></p>}
        </div>
      </li>;
    })}</ol>}
  </div>;
}

export default function SettingsPage({ aiStatus, onRefreshAiStatus, aiDiagnosis, onRunDiagnosis, savedApiCount, runCount, onExport, onImport, onDeleteAll }) {
  const fileInput = useRef(null);
  const [importMessage, setImportMessage] = useState(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const status = aiStatusLabel(aiStatus);

  async function handleImport(event) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    try {
      const result = onImport(await file.text());
      setImportMessage({ tone: "success", text: `Imported ${result.addedApis} new and ${result.updatedApis} updated APIs, and ${result.addedRuns} runs.` });
    } catch (caught) {
      setImportMessage({ tone: "error", text: caught.message || "The workspace could not be imported." });
    }
  }

  return <section className="history-page settings-page">
    <div className="page-eyebrow">PREFERENCES</div>
    <h1>Settings</h1>
    <p className="page-lede">Check the AI model and manage the data stored in this browser.</p>

    <section className="settings-card">
      <div className="settings-card-heading">
        <div><h2>AI model</h2><p>Used for scenario ideas and failure analysis. Configure it with <code>OLLAMA_BASE_URL</code> and <code>OLLAMA_MODEL</code> before starting the backend.</p></div>
        <div className="settings-buttons">
          <button className="secondary-button" type="button" onClick={onRefreshAiStatus} disabled={aiStatus?.loading}>{aiStatus?.loading ? "Checking…" : "Check again"}</button>
          <button className="primary-button" type="button" onClick={onRunDiagnosis} disabled={aiDiagnosis?.loading}><Icon name="spark" size={14} /> {aiDiagnosis?.loading ? "Diagnosing…" : "Run diagnosis"}</button>
        </div>
      </div>
      <dl className="settings-facts">
        <div><dt>Status</dt><dd><span className={`connection-status connection-${status.tone}`}><span className="connection-dot" aria-hidden="true" />{status.text}</span></dd></div>
        <div><dt>Provider</dt><dd>Ollama</dd></div>
        <div><dt>Ollama server</dt><dd><code>{aiStatus?.base_url || "—"}</code><small>The local model server the backend calls; the app itself runs at <code>{window.location.host}</code>.</small></dd></div>
        <div><dt>Model</dt><dd><code>{aiStatus?.model || "—"}</code></dd></div>
      </dl>
      {aiStatus?.reachable && !aiStatus.model_available && <p className="settings-note">The Ollama server is running but <code>{aiStatus.model}</code> is not installed. Installed models: {aiStatus.available_models?.length ? aiStatus.available_models.join(", ") : "none"}.</p>}
      {aiStatus && !aiStatus.loading && !aiStatus.reachable && <p className="settings-note">Start Ollama or check <code>OLLAMA_BASE_URL</code>. Everything except the AI features keeps working without it.</p>}
      {aiDiagnosis && <AiDiagnosis diagnosis={aiDiagnosis} />}
    </section>

    <section className="settings-card">
      <div className="settings-card-heading">
        <div><h2>Workspace data</h2><p>{savedApiCount} saved {savedApiCount === 1 ? "API" : "APIs"} and {runCount} {runCount === 1 ? "run" : "runs"} are stored only in this browser. Export them to keep a backup or move them to another browser.</p></div>
      </div>
      <div className="settings-actions">
        <button className="primary-button" type="button" onClick={onExport}><Icon name="arrow" size={15} /> Export workspace</button>
        <button className="secondary-button" type="button" onClick={() => fileInput.current?.click()}><Icon name="upload" size={15} /> Import workspace</button>
        <input ref={fileInput} type="file" accept="application/json,.json" hidden onChange={handleImport} />
      </div>
      <p className="settings-note">Imports merge with this browser’s data: APIs with the same id are replaced and runs already present are skipped. Credential-like values were redacted when runs were saved, but review an export before sharing it.</p>
      {importMessage && <div className={`alert ${importMessage.tone === "success" ? "success-alert" : "error-alert"}`} role="status"><Icon name={importMessage.tone === "success" ? "check" : "close"} size={16} />{importMessage.text}</div>}
    </section>

    <section className="settings-card settings-danger">
      <div className="settings-card-heading">
        <div><h2>Delete all local data</h2><p>Removes every saved API, edited AI check, and run from this browser. Export first if you may need them again.</p></div>
        {!confirmingDelete && <button className="danger-button" type="button" onClick={() => setConfirmingDelete(true)} disabled={!savedApiCount && !runCount}><Icon name="trash" size={15} /> Delete all</button>}
      </div>
      {confirmingDelete && <div className="history-confirm settings-confirm" role="group" aria-label="Confirm deleting all local data">
        <span>Delete {savedApiCount} {savedApiCount === 1 ? "API" : "APIs"} and {runCount} {runCount === 1 ? "run" : "runs"}? This cannot be undone.</span>
        <button className="secondary-button" type="button" onClick={() => setConfirmingDelete(false)}>Cancel</button>
        <button className="danger-button" type="button" onClick={() => { onDeleteAll(); setConfirmingDelete(false); }}>Delete everything</button>
      </div>}
    </section>
  </section>;
}
