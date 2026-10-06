import { parameterLabel } from "./categories.js";
import { parseJsonBody, parseStatusCodes } from "./scenarioDraft.js";

const parameterModeLabels = { default: "Use request details", omit: "Omit", custom: "Custom value" };

export default function ScenarioDraftEditor({
  draft,
  problems,
  parameters,
  sendsJsonBody,
  isFormBody,
  statusSuggestions,
  isDataChangingMethod,
  saveLabel,
  onChange,
  onCancel,
  onSave,
}) {
  const statusError = draft.expectedStatusCodes.trim() ? parseStatusCodes(draft.expectedStatusCodes).error : "";
  const bodyError = sendsJsonBody ? parseJsonBody(draft.jsonBody).error : "";
  const update = (changes) => onChange({ ...draft, ...changes });
  const updateParameter = (key, changes) => update({ parameters: { ...draft.parameters, [key]: { ...draft.parameters[key], ...changes } } });

  return (
    <form className="draft-editor" onSubmit={(event) => { event.preventDefault(); if (!problems.length) onSave(); }}>
      <div className="draft-editor-heading">
        <strong>Turn this idea into a check</strong>
        <span>Nothing is sent until you save the check and run it yourself.</span>
      </div>

      <label className="request-input">
        <span>Title<small>required</small></span>
        <input type="text" value={draft.title} maxLength={160} onChange={(event) => update({ title: event.target.value })} />
      </label>

      <label className="request-input">
        <span>Expected status<small>required · comma-separated</small></span>
        <input type="text" inputMode="numeric" value={draft.expectedStatusCodes} placeholder="e.g. 400, 422" onChange={(event) => update({ expectedStatusCodes: event.target.value })} />
        {statusError && <small className="request-input-help request-input-error">{statusError}</small>}
        {statusSuggestions.length > 0 && <div className="draft-suggestions">
          {statusSuggestions.map((suggestion) => <button key={suggestion.label} type="button" className="draft-chip" onClick={() => update({ expectedStatusCodes: suggestion.codes.join(", ") })}>
            {suggestion.label}: {suggestion.codes.join(", ")}
          </button>)}
          <small>From the contract’s documented responses</small>
        </div>}
      </label>

      {parameters.length > 0 && <fieldset className="draft-section">
        <legend>Parameters</legend>
        {parameters.map((parameter) => {
          const key = `${parameter.location}:${parameter.name}`;
          const setting = draft.parameters[key] ?? { mode: "default", value: "" };
          return <div className="request-input" key={key}>
            <span>{parameter.name}<small>{parameterLabel(parameter)}</small></span>
            <div className="draft-parameter-control">
              <select aria-label={`${parameter.name} value`} value={setting.mode} onChange={(event) => updateParameter(key, { mode: event.target.value })}>
                {Object.entries(parameterModeLabels).map(([mode, label]) => <option key={mode} value={mode}>{label}</option>)}
              </select>
              {setting.mode === "custom" && <input type={parameter.location === "header" ? "password" : "text"} aria-label={`Custom ${parameter.name}`} value={setting.value} placeholder={`Value for ${parameter.name}`} onChange={(event) => updateParameter(key, { value: event.target.value })} />}
            </div>
          </div>;
        })}
      </fieldset>}

      {sendsJsonBody && <label className="request-input draft-body">
        <span>Request body JSON<small>sent exactly as written · leave empty for no body</small></span>
        <textarea rows="7" value={draft.jsonBody} onChange={(event) => update({ jsonBody: event.target.value })} />
        {bodyError && <small className="request-input-help request-input-error">{bodyError}</small>}
      </label>}

      {isFormBody && Object.keys(draft.formFields).length > 0 && <fieldset className="draft-section">
        <legend>Form fields</legend>
        {Object.entries(draft.formFields).map(([name, value]) => <label className="request-input" key={name}>
          <span>{name}<small>empty values are not sent</small></span>
          <input type="text" value={value} onChange={(event) => update({ formFields: { ...draft.formFields, [name]: event.target.value } })} />
        </label>)}
        <small className="draft-note">Files come from the request details above.</small>
      </fieldset>}

      {isDataChangingMethod && <small className="draft-note draft-warning">This endpoint may change data. You will be asked to confirm before it runs.</small>}

      <div className="draft-actions">
        {problems.length > 0 && <span className="draft-status">{problems.length === 1 ? problems[0] : `${problems.length} items need attention before saving.`}</span>}
        <button className="secondary-button" type="button" onClick={onCancel}>Cancel</button>
        <button className="primary-button" type="submit" disabled={problems.length > 0}>{saveLabel}</button>
      </div>
    </form>
  );
}
