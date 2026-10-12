import { useState } from "react";
import { blankStep, draftHasSensitiveBody, MAX_FLOW_STEPS, moveStep, STEP_METHODS, STEP_ROLES, validateFlowDraft } from "./flowEditor.js";
import { ROLE_LABELS } from "./flows.js";
import Icon from "./Icon.jsx";

const BODYLESS = new Set(["GET", "HEAD", "OPTIONS", "DELETE"]);

function FieldError({ message }) {
  return message ? <small className="request-input-help request-input-error" role="alert">{message}</small> : null;
}

function StepEditor({ step, index, count, errors, onChange, onMove, onRemove }) {
  const field = (name) => errors[`steps.${index}.${name}`];
  const update = (changes) => onChange({ ...step, ...changes });
  const updateRule = (ruleIndex, changes) => update({ extract: step.extract.map((rule, current) => current === ruleIndex ? { ...rule, ...changes } : rule) });
  const showBody = !BODYLESS.has(step.method) || step.bodyText.trim();
  return <li className="flow-edit-step">
    <div className="flow-edit-step-heading">
      <span className="flow-step-number" aria-hidden="true">{index + 1}</span>
      <input className="flow-edit-title" aria-label={`Step ${index + 1} name`} value={step.title} onChange={(event) => update({ title: event.target.value })} placeholder="Step name, such as Create a pet" />
      <div className="flow-edit-step-actions">
        <button className="icon-button" type="button" disabled={index === 0} onClick={() => onMove(-1)} aria-label={`Move step ${index + 1} up`} title="Move up"><Icon name="chevron" size={15} className="flow-icon-up" /></button>
        <button className="icon-button" type="button" disabled={index === count - 1} onClick={() => onMove(1)} aria-label={`Move step ${index + 1} down`} title="Move down"><Icon name="chevron" size={15} className="flow-icon-down" /></button>
        <button className="icon-button" type="button" disabled={count === 1} onClick={onRemove} aria-label={`Remove step ${index + 1}`} title="Remove step"><Icon name="trash" size={15} /></button>
      </div>
    </div>
    <FieldError message={field("title")} />
    <div className="flow-edit-grid">
      <label className="flow-edit-field flow-edit-method"><span>Method</span><select value={step.method} onChange={(event) => update({ method: event.target.value })}>{STEP_METHODS.map((method) => <option key={method}>{method}</option>)}</select></label>
      <label className="flow-edit-field flow-edit-path"><span>Path</span><input value={step.path} onChange={(event) => update({ path: event.target.value })} placeholder="/pets/{{petId}}" spellCheck="false" /><FieldError message={field("path") || field("placeholders")} /></label>
      <label className="flow-edit-field"><span>Expected status</span><input value={step.codesText} onChange={(event) => update({ codesText: event.target.value })} placeholder="200, 201" inputMode="numeric" /><FieldError message={field("codesText")} /></label>
      <label className="flow-edit-field"><span>Role</span><select value={step.role} onChange={(event) => update({ role: event.target.value })}>{STEP_ROLES.map((role) => <option key={role} value={role}>{ROLE_LABELS[role]}</option>)}</select></label>
    </div>
    <label className="flow-edit-field"><span>Query parameters <small>one name=value per line</small></span><textarea rows="2" value={step.queryText} onChange={(event) => update({ queryText: event.target.value })} spellCheck="false" /><FieldError message={field("queryText")} /></label>
    {showBody && <label className="flow-edit-field"><span>JSON body <small>leave empty to send none</small></span><textarea rows="5" value={step.bodyText} onChange={(event) => update({ bodyText: event.target.value })} spellCheck="false" /><FieldError message={field("bodyText")} /></label>}
    <div className="flow-edit-field">
      <span>Values saved for later steps</span>
      {step.extract.map((rule, ruleIndex) => <div className="flow-edit-rule" key={ruleIndex}>
        <input aria-label="Saved value name" value={rule.variable} onChange={(event) => updateRule(ruleIndex, { variable: event.target.value })} placeholder="petId" spellCheck="false" />
        <span>from</span>
        <select aria-label="Saved value source" value={rule.source} onChange={(event) => updateRule(ruleIndex, { source: event.target.value })}><option value="response_body">the response</option><option value="request_body">the request</option></select>
        <input aria-label="Saved value location" value={rule.pointer} onChange={(event) => updateRule(ruleIndex, { pointer: event.target.value })} placeholder="/id" spellCheck="false" />
        <button className="icon-button" type="button" onClick={() => update({ extract: step.extract.filter((_, current) => current !== ruleIndex) })} aria-label="Remove saved value" title="Remove"><Icon name="close" size={14} /></button>
        <FieldError message={field(`extract.${ruleIndex}`)} />
      </div>)}
      <button className="text-button flow-edit-add-rule" type="button" onClick={() => update({ extract: [...step.extract, { variable: "", source: "response_body", pointer: "/id" }] })}>+ Save a value</button>
    </div>
    <label className="flow-edit-check"><input type="checkbox" checked={step.always_run} onChange={(event) => update({ always_run: event.target.checked })} /><span>Run even after an earlier step fails <small>for cleanup, such as deleting what the flow created</small></span></label>
  </li>;
}

// Edits a flow's steps; `onSave` receives the draft only when it is valid.
export default function FlowEditor({ initialDraft, isNew, onSave, onCancel }) {
  const [draft, setDraft] = useState(initialDraft);
  const [attempted, setAttempted] = useState(false);
  const errors = validateFlowDraft(draft);
  const visible = attempted ? errors : Object.fromEntries(Object.entries(errors).filter(([key]) => key.endsWith(".placeholders")));
  const setSteps = (steps) => setDraft((current) => ({ ...current, steps }));
  const save = () => {
    setAttempted(true);
    if (!Object.keys(errors).length) onSave(draft);
  };

  return <div className="flow-editor">
    <label className="flow-edit-field"><span>Flow name</span><input value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} /><FieldError message={visible.title} /></label>
    <p className="flow-edit-help">Use <code>{"{{name}}"}</code> in a path, query value, or body to send a value an earlier step saved. Leave a path parameter such as <code>{"{ownerId}"}</code> as it is to fill it in before running.</p>
    <ol className="flow-edit-steps">{draft.steps.map((step, index) => <StepEditor
      key={index}
      step={step}
      index={index}
      count={draft.steps.length}
      errors={visible}
      onChange={(next) => setSteps(draft.steps.map((item, current) => current === index ? next : item))}
      onMove={(offset) => setSteps(moveStep(draft.steps, index, offset))}
      onRemove={() => setSteps(draft.steps.filter((_, current) => current !== index))}
    />)}</ol>
    <FieldError message={visible.steps} />
    {draftHasSensitiveBody(draft) && <p className="flow-edit-help flow-edit-warning">Body fields that look like credentials (password, token, …) are not saved with the flow, like other request details.</p>}
    <div className="flow-footer">
      <button className="secondary-button" type="button" disabled={draft.steps.length >= MAX_FLOW_STEPS} onClick={() => setSteps([...draft.steps, blankStep()])}>+ Add step</button>
      {attempted && Object.keys(errors).length > 0 && <span className="run-footer-warning" role="status">Fix the marked fields to save.</span>}
      <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
      <button className="primary-button" type="button" onClick={save}><Icon name="check" size={14} /> {isNew ? "Create flow" : "Save flow"}</button>
    </div>
  </div>;
}
