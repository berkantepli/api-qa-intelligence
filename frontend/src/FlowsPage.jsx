import { useState } from "react";
import ErrorAlert from "./ErrorAlert.jsx";
import FlowEditor from "./FlowEditor.jsx";
import { flowToDraft, isCustomFlow, newFlowDraft } from "./flowEditor.js";
import Icon from "./Icon.jsx";
import { credentialValue, dataChangingSteps, flowCredentials, missingFlowInputs, ROLE_LABELS } from "./flows.js";
import { SchemaDifferences } from "./RunDetail.jsx";
import { outcomeSummary } from "./runDetail.js";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

function StepResult({ result }) {
  const outcome = result.status;
  const check = result.check;
  return <div className="flow-step-result">
    <span className={`history-status status-${outcome.toLowerCase()}`}>{outcome}</span>
    {check?.response_status != null && <span>HTTP {check.response_status} · {check.duration_ms} ms</span>}
    {Object.entries(result.saved_values ?? {}).map(([name, value]) => <code key={name} className="flow-saved">{name} = {String(value)}</code>)}
    {/* A schema difference is listed below; the summary sentence would only repeat it. */}
    {/* A connection error already says why there is no response; the summary would only repeat it. */}
    {outcome !== "PASS" && (result.reason || (check && !check.error && check.schema_check?.status !== "failed")) && <p>{result.reason || outcomeSummary(check)}</p>}
    {outcome !== "PASS" && check?.error && <p>{check.error}</p>}
    {check && <SchemaDifferences check={check.schema_check} />}
  </div>;
}

const SOURCE_LABELS = { openapi_link: "From OpenAPI links", inferred: "Inferred from paths", custom: "Built by you" };

function FlowCard({ overview, flow, state, pathValues, inputsByOperation, targetUrl, targetProblem, onPathValueChange, onCredentialChange, onRun, onOpenRun, onSaveFlow, onResetFlow, onDeleteFlow }) {
  const [confirming, setConfirming] = useState(false);
  const [editing, setEditing] = useState(false);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);
  const custom = isCustomFlow(flow);
  const credentials = flowCredentials(overview, flow);
  const missing = missingFlowInputs(flow, pathValues);
  const writes = dataChangingSteps(flow);
  const running = state?.running;
  const outcome = state?.outcome;
  const blocked = missing.length ? `Fill in ${missing.join(", ")} first.` : targetProblem;
  const run = () => { setConfirming(false); onRun(flow); };

  return <article className="flow-card">
    <div className="flow-card-heading">
      <div>
        <div className="flow-card-pills">
          <span className={flow.source === "openapi_link" ? "coverage-risk" : "coverage-risk coverage-risk-impact"}>{SOURCE_LABELS[flow.source] ?? flow.source}</span>
          {flow.edited && <span className="edited-pill">Edited</span>}
          {writes.length > 0 && <span className="mutation-badge">Changes data</span>}
          {outcome && <span className={`history-status status-${outcome.result.toLowerCase()}`}>{outcome.result}</span>}
        </div>
        <h2>{flow.title}</h2>
        <p>{flow.rationale}</p>
      </div>
      {!editing && <div className="flow-card-actions">
        <button className="text-button" type="button" disabled={running} onClick={() => { setEditing(true); setConfirming(false); }}>Edit</button>
        {(custom || flow.edited) && <button className={custom ? "text-button danger" : "text-button"} type="button" disabled={running} onClick={() => setConfirmingRemoval(true)}>{custom ? "Delete" : "Reset to suggested"}</button>}
      </div>}
    </div>
    {confirmingRemoval && <div className="spec-card-confirm" role="group" aria-label={custom ? "Delete flow" : "Reset flow"}>
      <span>{custom ? "Delete this flow? Its runs stay in Run history." : "Discard your changes and go back to the suggested flow?"}</span>
      <button className="secondary-button" type="button" onClick={() => setConfirmingRemoval(false)}>Cancel</button>
      <button className={custom ? "danger-button" : "primary-button"} type="button" onClick={() => { setConfirmingRemoval(false); (custom ? onDeleteFlow : onResetFlow)(flow.id); }}>{custom ? "Delete" : "Reset"}</button>
    </div>}
    {editing ? <FlowEditor initialDraft={flowToDraft(flow)} onCancel={() => setEditing(false)} onSave={(draft) => { onSaveFlow(draft, flow); setEditing(false); }} /> : <>
    {flow.notes?.length > 0 && <ul className="flow-notes">{flow.notes.map((note) => <li key={note}>{note}</li>)}</ul>}

    <ol className="flow-steps">{flow.steps.map((step, index) => {
      const result = outcome?.steps?.[index];
      return <li key={`${step.title}-${index}`} className={result ? `flow-step flow-step-${result.status.toLowerCase()}` : "flow-step"}>
        <span className="flow-step-number" aria-hidden="true">{index + 1}</span>
        <div className="flow-step-body">
          <div className="flow-step-line">
            <span className={`method-tag method-${step.method.toLowerCase()}`}>{step.method}</span>
            <code>{step.path}</code>
          </div>
          <div className="flow-step-meta">
            <strong>{step.title}</strong>
            <span className="review-pill">{ROLE_LABELS[step.role] ?? step.role}</span>
            <span>expects {step.expected_status_codes.join(" or ")}</span>
            {step.extract.map((rule) => <span key={rule.variable} className="flow-saves">saves {`{{${rule.variable}}}`} from {rule.source === "request_body" ? "the request" : "the response"} {rule.pointer}</span>)}
            {step.always_run && <span>runs even after a failure</span>}
          </div>
          {result && <StepResult result={result} />}
        </div>
      </li>;
    })}</ol>

    {(flow.missing_inputs?.length > 0 || credentials.length > 0) && <div className="request-inputs flow-inputs">
      <div className="request-inputs-heading"><div><strong>Flow inputs</strong><span>Values the flow cannot take from an earlier step.</span></div></div>
      {(flow.missing_inputs ?? []).map((name) => <label key={name} className={`request-input ${missing.includes(name) ? "request-input-missing" : ""}`}>
        <span>{name}<small>path parameter · required</small></span>
        <input type="text" value={pathValues[name] ?? ""} disabled={running} onChange={(event) => onPathValueChange(flow.id, name, event.target.value)} placeholder={`Enter ${name}`} />
      </label>)}
      {credentials.map((credential) => <label key={credential.key} className="request-input">
        <span>{credential.name}<small>{credential.location} · credential · optional</small></span>
        <input type="password" value={credentialValue(credential, inputsByOperation)} disabled={running} onChange={(event) => onCredentialChange(credential, event.target.value)} placeholder="Leave empty to call without credentials" />
        <small className="request-input-help">Sent with every step that documents it. Kept only in this tab.</small>
      </label>)}
    </div>}

    {confirming && <div className="execution-confirmation" role="alert">
      <div><strong>This flow changes data.</strong><p>It sends {plural(writes.length, "data-changing request")} ({[...new Set(writes.map((step) => step.method))].join(", ")}) to {targetUrl}. {flow.steps.some((step) => step.always_run) ? "The last steps delete what the flow created, even if an earlier step fails." : "Nothing in the contract deletes what it creates, so the test data stays."}</p></div>
      <div className="execution-confirmation-actions"><button className="secondary-button" type="button" onClick={() => setConfirming(false)}>Cancel</button><button className="primary-button" type="button" onClick={run}>Confirm and run</button></div>
    </div>}
    <ErrorAlert message={state?.error} className="run-error" />
    <div className="flow-footer">
      {state?.runId && !running && <button className="text-button" type="button" onClick={() => onOpenRun(state.runId)}>View run details</button>}
      {blocked ? <span className="run-footer-warning" role="status">{blocked}</span> : <span>{plural(flow.steps.length, "step")} · requests go to <code>{targetUrl}</code></span>}
      <button className="primary-button" type="button" disabled={running || Boolean(blocked)} onClick={() => (writes.length ? setConfirming(true) : run())}>
        {running ? <><span className="spinner" /> Running…</> : <><Icon name="run" size={15} /> Run flow</>}
      </button>
    </div>
    </>}
  </article>;
}

// Multi-step checks that carry a created record's id through read, update, and delete.
export default function FlowsPage({ overview, flows, suggestion, flowStates, pathValuesFor, onGoToSpecs, onRetrySuggestion, ...cardProps }) {
  const [creating, setCreating] = useState(false);
  if (!overview) {
    return <section className="history-page flows-page">
      <div className="page-eyebrow">MULTI-STEP CHECKS</div>
      <h1>Flows</h1>
      <div className="history-empty"><Icon name="run" size={25} /><strong>No active API</strong><span>Import or open an API to see the flows its contract suggests.</span><button className="secondary-button" onClick={onGoToSpecs}>Go to API specs</button></div>
    </section>;
  }
  return <section className="history-page flows-page">
    <div className="page-eyebrow">MULTI-STEP CHECKS</div>
    <div className="flows-heading">
      <h1>Flows</h1>
      {!creating && <button className="secondary-button" type="button" onClick={() => setCreating(true)}>+ New flow</button>}
    </div>
    {creating && <article className="flow-card"><h2>New flow</h2><FlowEditor isNew initialDraft={newFlowDraft()} onCancel={() => setCreating(false)} onSave={(draft) => { cardProps.onSaveFlow(draft, null); setCreating(false); }} /></article>}
    <p className="page-lede">Each flow creates a record, passes its id to the next requests, and cleans up after itself. Steps are judged like single checks: status code, documented schema, and time limit.</p>
    {suggestion?.loading ? <div className="history-empty"><span className="spinner" /><span>Looking for flows in {overview.title}…</span></div>
      : suggestion?.error ? <div className="flows-suggestion-error"><ErrorAlert message={suggestion.error} /><button className="secondary-button" type="button" onClick={onRetrySuggestion}>Try again</button></div>
      : flows.length ? <div className="flow-list">{flows.map((flow) => <FlowCard key={flow.id} overview={overview} flow={flow} state={flowStates[flow.id]} pathValues={pathValuesFor(flow.id)} {...cardProps} />)}</div>
      : <div className="history-empty"><Icon name="run" size={25} /><strong>No flows suggested for this contract</strong><span>Flows are suggested when a collection has a POST (such as <code>POST /pets</code>) and its records have a GET or DELETE (<code>/pets/{"{petId}"}</code>), with the new id in the create response, the request body, the Location header, or an OpenAPI link. You can also build one with <b>New flow</b>.</span></div>}
  </section>;
}
