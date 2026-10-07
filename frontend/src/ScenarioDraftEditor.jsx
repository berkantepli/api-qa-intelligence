import { useRef, useState } from "react";
import { parameterLabel } from "./categories.js";
import { parameterModes } from "./scenarioDraft.js";

const parameterModeLabels = { default: "Use request details", omit: "Omit", empty: "Send empty value", custom: "Custom value" };

function FieldError({ message }) {
  return message ? <small className="request-input-help request-input-error" role="alert">{message}</small> : null;
}

export default function ScenarioDraftEditor({
  draft,
  errors,
  parameters,
  sendsJsonBody,
  isFormBody,
  statusSuggestions,
  isDataChangingMethod,
  saveLabel,
  onChange,
  onClose,
  onDiscard,
  onSave,
}) {
  const form = useRef(null);
  // Missing values are only flagged after a save attempt; values that are typed but invalid show right away.
  const [attempted, setAttempted] = useState(false);
  const visible = (key, typed) => (attempted || typed ? errors[key] : undefined);
  const expectedError = visible("expected", draft.expectedStatusCodes.trim());
  const titleError = visible("title", false);
  const bodyError = visible("body", draft.jsonBody.trim());
  const errorCount = Object.keys(errors).length;
  const update = (changes) => onChange({ ...draft, ...changes });

  function submit(event) {
    event.preventDefault();
    if (!errorCount) {
      onSave();
      return;
    }
    setAttempted(true);
    // Wait for the error styles to render, then move focus to the first invalid input.
    window.setTimeout(() => form.current?.querySelector("[aria-invalid='true']")?.focus(), 0);
  }
  const updateParameter = (key, changes) => update({ parameters: { ...draft.parameters, [key]: { ...draft.parameters[key], ...changes } } });

  return (
    <form className="draft-editor" ref={form} noValidate onSubmit={submit}>
      <div className="draft-editor-heading">
        <strong>Turn this idea into a check</strong>
        <span>Nothing is sent until you save the check and run it yourself.</span>
      </div>

      <label className="request-input">
        <span>Title<small>required</small></span>
        <input type="text" value={draft.title} maxLength={160} aria-invalid={Boolean(titleError)} onChange={(event) => update({ title: event.target.value })} />
        <FieldError message={titleError} />
      </label>

      <label className="request-input">
        <span>Expected status<small>required · comma-separated</small></span>
        <input type="text" inputMode="numeric" value={draft.expectedStatusCodes} placeholder="e.g. 400, 422" aria-invalid={Boolean(expectedError)} onChange={(event) => update({ expectedStatusCodes: event.target.value })} />
        <FieldError message={expectedError} />
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
                {parameterModes(parameter).map((mode) => <option key={mode} value={mode}>{parameterModeLabels[mode]}</option>)}
              </select>
              {setting.mode === "custom" && <input type={parameter.location === "header" ? "password" : "text"} aria-label={`Custom ${parameter.name}`} aria-invalid={Boolean(visible(key, false))} value={setting.value} placeholder={`Value for ${parameter.name}`} onChange={(event) => updateParameter(key, { value: event.target.value })} />}
            </div>
            <FieldError message={visible(key, false)} />
          </div>;
        })}
      </fieldset>}

      {sendsJsonBody && <label className="request-input draft-body">
        <span>Request body JSON<small>sent exactly as written · leave empty for no body</small></span>
        <textarea rows="7" value={draft.jsonBody} aria-invalid={Boolean(bodyError)} onChange={(event) => update({ jsonBody: event.target.value })} />
        <FieldError message={bodyError} />
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
        <span className="draft-status">
          {attempted && errorCount > 0
            ? <b className="request-input-error">{errorCount === 1 ? "Fix the highlighted field to save." : `Fix the ${errorCount} highlighted fields to save.`}</b>
            : "Closing keeps this draft until you save or discard it."}
        </span>
        <button className="text-button danger" type="button" onClick={onDiscard}>Discard draft</button>
        <button className="secondary-button" type="button" onClick={onClose}>Close</button>
        <button className="primary-button" type="submit">{saveLabel}</button>
      </div>
    </form>
  );
}
