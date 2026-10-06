import { useRef, useState } from "react";
import Icon from "./Icon.jsx";

export function aiStatusLabel(aiStatus) {
  if (!aiStatus || aiStatus.loading) return { tone: "checking", text: "Checking AI model" };
  if (aiStatus.error || !aiStatus.reachable) return { tone: "unavailable", text: "AI model unavailable" };
  if (!aiStatus.model_available) return { tone: "warning", text: "Model not installed" };
  return { tone: "connected", text: "AI model ready" };
}

export default function SettingsPage({ aiStatus, onRefreshAiStatus, savedApiCount, runCount, onExport, onImport, onDeleteAll }) {
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
        <button className="secondary-button" type="button" onClick={onRefreshAiStatus} disabled={aiStatus?.loading}>{aiStatus?.loading ? "Checking…" : "Check again"}</button>
      </div>
      <dl className="settings-facts">
        <div><dt>Status</dt><dd><span className={`connection-status connection-${status.tone}`}><span className="connection-dot" aria-hidden="true" />{status.text}</span></dd></div>
        <div><dt>Provider</dt><dd>Ollama</dd></div>
        <div><dt>Server</dt><dd><code>{aiStatus?.base_url || "—"}</code></dd></div>
        <div><dt>Model</dt><dd><code>{aiStatus?.model || "—"}</code></dd></div>
      </dl>
      {aiStatus?.reachable && !aiStatus.model_available && <p className="settings-note">The server is running but <code>{aiStatus.model}</code> is not installed. Installed models: {aiStatus.available_models?.length ? aiStatus.available_models.join(", ") : "none"}.</p>}
      {aiStatus && !aiStatus.loading && !aiStatus.reachable && <p className="settings-note">Start Ollama or check <code>OLLAMA_BASE_URL</code>. Everything except the AI features keeps working without it.</p>}
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
