import { useState } from "react";
import { postJson } from "./apiClient.js";
import { buildSignInRequest, credentialFromToken, signInBodyTemplate, signInCandidates } from "./apiCredentials.js";
import ErrorAlert from "./ErrorAlert.jsx";
import FlowEditor from "./FlowEditor.jsx";
import { flowToDraft, isCustomFlow, newFlowDraft } from "./flowEditor.js";
import Icon from "./Icon.jsx";
import { accessCheckFlow, accessCheckProblem, accessFinding, credentialValue, dataChangingSteps, flowCredentials, missingFlowInputs, ROLE_LABELS } from "./flows.js";
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

const VERDICTS = {
  fail: "The second user reached the first user's record: at least one request does not check who owns it.",
  unknown: "Inconclusive: at least one attempt proves nothing. See below.",
  pass: "The second user was refused every time.",
};

// Gets the second user's token from the contract's sign-in request, like Target & auth does for the
// first user. The token only goes into this tab's memory.
function SecondUserSignIn({ overview, credential, targetUrl, targetProblem, disabled, onToken }) {
  const operationKey = signInCandidates(overview)[0];
  const operation = (overview?.operations ?? []).find((item) => `${item.method} ${item.path}` === operationKey);
  const [bodyText, setBodyText] = useState(() => signInBodyTemplate(operation));
  const [status, setStatus] = useState({ loading: false, error: "", message: "" });
  if (!operation || !credential) return null;
  async function signIn() {
    if (targetProblem) return setStatus({ loading: false, error: targetProblem, message: "" });
    const built = buildSignInRequest(operation, { targetUrl, bodyText, tokenPointer: "" });
    if (built.error) return setStatus({ loading: false, error: built.error, message: "" });
    setStatus({ loading: true, error: "", message: "" });
    try {
      const result = await postJson("/api/v1/auth/sign-in", built.request, "The sign-in request could not be sent.");
      if (!result.signed_in) return setStatus({ loading: false, error: result.error, message: "" });
      onToken(credential.key, credentialFromToken(credential, result.token));
      setStatus({ loading: false, error: "", message: `Signed in as the second user (HTTP ${result.status_code}); ${credential.name} is set for this check.` });
    } catch (caught) {
      setStatus({ loading: false, error: caught.message, message: "" });
    }
  }
  return <details className="access-check-signin">
    <summary>Sign in as the second user<small>{operationKey}</small></summary>
    <label className="request-input"><span>Second user&apos;s sign-in body<small>JSON · use another test account</small></span>
      <textarea rows="4" value={bodyText} disabled={disabled || status.loading} onChange={(event) => setBodyText(event.target.value)} />
    </label>
    <ErrorAlert message={status.error} />
    {status.message && <p className="access-check-signed-in" role="status">{status.message}</p>}
    <button className="secondary-button" type="button" disabled={disabled || status.loading} onClick={signIn}>{status.loading ? <><span className="spinner" /> Signing in…</> : "Sign in as the second user"}</button>
  </details>;
}

// OWASP API1:2023 (Broken Object Level Authorization): the first user creates a record, a second
// user tries to read, change, and delete it, and the first user checks it and cleans up.
function AccessCheck({ overview, flow, state, pathValues, inputsByOperation, secondUser, targetUrl, targetProblem, onSecondUserChange, onRun, onOpenRun }) {
  const [confirming, setConfirming] = useState(false);
  const access = accessCheckFlow(flow, overview);
  if (!access) return null;
  const credentials = flowCredentials(overview, flow);
  const missing = missingFlowInputs(flow, pathValues);
  const problem = (missing.length ? `Fill in ${missing.join(", ")} first.` : null) || accessCheckProblem(overview, access, inputsByOperation, secondUser) || targetProblem;
  const running = state?.running;
  const findings = (state?.outcome?.steps ?? []).map((step, index) => accessFinding({
    actor: access.steps[index]?.actor, role: step.role, result: step.status, response_status: step.check?.response_status ?? null,
  })).filter(Boolean);
  const verdict = findings.some((item) => item.tone === "fail") ? "fail" : findings.some((item) => item.tone === "unknown") ? "unknown" : findings.length ? "pass" : null;
  const run = () => { setConfirming(false); onRun(flow); };

  return <details className="access-check" open={Boolean(state) || undefined}>
    <summary>Access check<small>Can another user reach this record? · OWASP API1:2023</small></summary>
    <p className="access-check-lede">The first user (your credentials under Target &amp; auth) creates a record. A second user then tries to read, change, and delete it and must get 403 or 404; steps whose endpoint needs no credentials are skipped, since anyone may use them. The first user checks that the record is still there and deletes it.</p>
    {credentials.length > 0 && <div className="request-inputs access-check-inputs">
      {credentials.map((credential) => <label key={credential.key} className="request-input">
        <span>Second user&apos;s {credential.name}<small>{credential.location} · kept only in this tab</small></span>
        <input type="password" autoComplete="off" value={secondUser[credential.key] ?? ""} disabled={running} onChange={(event) => onSecondUserChange(credential.key, event.target.value)} placeholder="Another test account's value" />
      </label>)}
      <SecondUserSignIn overview={overview} credential={credentials.find((item) => item.location === "header") ?? credentials[0]} targetUrl={targetUrl} targetProblem={targetProblem} disabled={running} onToken={onSecondUserChange} />
    </div>}
    {verdict && <div className={`access-verdict access-verdict-${verdict}`} role="status">
      <strong>{VERDICTS[verdict]}</strong>
      <ul>{findings.map((item, index) => <li key={index} className={`access-finding-${item.tone}`}>{item.text}</li>)}</ul>
    </div>}
    {confirming && <div className="execution-confirmation" role="alert">
      <div><strong>The access check changes data.</strong><p>It creates a record as the first user, lets the second user try to change and delete it, and deletes it at the end, all on {targetUrl}.</p></div>
      <div className="execution-confirmation-actions"><button className="secondary-button" type="button" onClick={() => setConfirming(false)}>Cancel</button><button className="primary-button" type="button" onClick={run}>Confirm and run</button></div>
    </div>}
    <ErrorAlert message={state?.error} className="run-error" />
    <div className="flow-footer">
      {state?.runId && !running && <button className="text-button" type="button" onClick={() => onOpenRun(state.runId)}>View run details</button>}
      {problem ? <span className="run-footer-warning" role="status">{problem}</span> : <span>{plural(access.steps.length, "step")} · requests go to <code>{targetUrl}</code></span>}
      <button className="secondary-button" type="button" disabled={running || Boolean(problem)} onClick={() => setConfirming(true)}>
        {running ? <><span className="spinner" /> Running…</> : <><Icon name="shield" size={15} /> Run access check</>}
      </button>
    </div>
  </details>;
}

function FlowCard({ overview, flow, state, pathValues, inputsByOperation, targetUrl, targetProblem, onPathValueChange, onCredentialChange, onRun, onOpenRun, onSaveFlow, onResetFlow, onDeleteFlow, accessState, secondUser = {}, onSecondUserChange, onRunAccess }) {
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
    <AccessCheck overview={overview} flow={flow} state={accessState} pathValues={pathValues} inputsByOperation={inputsByOperation} secondUser={secondUser}
      targetUrl={targetUrl} targetProblem={targetProblem} onSecondUserChange={onSecondUserChange} onRun={onRunAccess} onOpenRun={onOpenRun} />
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
      : flows.length ? <div className="flow-list">{flows.map((flow) => <FlowCard key={flow.id} overview={overview} flow={flow} state={flowStates[flow.id]} accessState={flowStates[`${flow.id}:access`]} pathValues={pathValuesFor(flow.id)} {...cardProps} />)}</div>
      : <div className="history-empty"><Icon name="run" size={25} /><strong>No flows suggested for this contract</strong><span>Flows are suggested when a collection has a POST (such as <code>POST /pets</code>) and its records have a GET or DELETE (<code>/pets/{"{petId}"}</code>), with the new id in the create response, the request body, the Location header, or an OpenAPI link. You can also build one with <b>New flow</b>.</span></div>}
  </section>;
}
