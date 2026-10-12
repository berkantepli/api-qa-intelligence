import { useState } from "react";
import { postJson } from "./apiClient.js";
import { buildSignInRequest, credentialFromToken, signInBodyTemplate, signInCandidates } from "./apiCredentials.js";
import ErrorAlert from "./ErrorAlert.jsx";
import Icon from "./Icon.jsx";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;

// Where the active API's checks go and how they authenticate; shared by every page.
export default function ConnectionPanel({
  overview,
  targetUrl,
  onTargetUrlChange,
  targetProblem,
  timeLimit,
  credentials,
  credentialValues,
  onCredentialChange,
  remember,
  onRememberChange,
  signIn,
  onSignInChange,
  signInBody,
  onSignInBodyChange,
  onClose,
}) {
  const candidates = signInCandidates(overview);
  const [showSignIn, setShowSignIn] = useState(Boolean(signIn?.operationKey));
  const [status, setStatus] = useState({ loading: false, error: "", message: "" });
  const operationKey = candidates.includes(signIn?.operationKey) ? signIn.operationKey : candidates[0] ?? "";
  const operation = overview?.operations?.find((item) => `${item.method} ${item.path}` === operationKey);
  const targetCredential = credentials.find((item) => item.key === signIn?.credentialKey) ?? credentials[0];
  const bodyText = signInBody ?? signInBodyTemplate(operation);

  function changeSignIn(update) {
    setStatus({ loading: false, error: "", message: "" });
    onSignInChange({ operationKey, tokenPointer: signIn?.tokenPointer ?? "", credentialKey: targetCredential?.key ?? "", ...update });
  }

  async function runSignIn() {
    if (!operation || !targetCredential) return;
    if (targetProblem) {
      setStatus({ loading: false, error: targetProblem, message: "" });
      return;
    }
    const built = buildSignInRequest(operation, { targetUrl, bodyText, tokenPointer: signIn?.tokenPointer ?? "" });
    if (built.error) {
      setStatus({ loading: false, error: built.error, message: "" });
      return;
    }
    setStatus({ loading: true, error: "", message: "" });
    try {
      const result = await postJson("/api/v1/auth/sign-in", built.request, "The sign-in request could not be sent.");
      if (!result.signed_in) {
        setStatus({ loading: false, error: result.error, message: "" });
        return;
      }
      onCredentialChange(targetCredential.key, credentialFromToken(targetCredential, result.token));
      onSignInChange({ operationKey, tokenPointer: signIn?.tokenPointer ?? "", credentialKey: targetCredential.key });
      setStatus({ loading: false, error: "", message: `Signed in (HTTP ${result.status_code}, token at ${result.token_pointer}). ${targetCredential.name} is set for ${plural(targetCredential.operationKeys.length, "endpoint")}.` });
    } catch (caught) {
      setStatus({ loading: false, error: caught.message, message: "" });
    }
  }

  return <section className="connection-panel" aria-label="Target and authentication">
    <div className="connection-panel-heading">
      <div><h2>Target and authentication</h2><p>Every check, bulk run, and flow of this API uses these settings.</p></div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close target and authentication" title="Close"><Icon name="close" size={16} /></button>
    </div>
    <div className="connection-panel-grid">
      <div className="connection-panel-section">
        <label className="target-field"><span>Target API base URL</span><input value={targetUrl} onChange={(event) => onTargetUrlChange(event.target.value)} placeholder="http://127.0.0.1:8000" /></label>
        {targetProblem && <small className="request-input-help request-input-error connection-panel-note" role="status">{targetProblem}</small>}
        <label className="target-field time-limit-field"><span>Response time limit</span><input type="number" min="1" max="120000" step="100" inputMode="numeric" value={timeLimit.value} onChange={(event) => timeLimit.onChange(event.target.value)} onBlur={timeLimit.onBlur} aria-invalid={timeLimit.invalid} placeholder="No limit" />{timeLimit.invalid ? <small className="request-input-error" role="alert">Enter a whole number from 1 to 120000 ms. The saved limit{timeLimit.saved ? ` (${timeLimit.saved} ms)` : ""} is kept.</small> : <small>ms · a slower response fails the check</small>}</label>
      </div>
      <div className="connection-panel-section">
        <strong className="connection-panel-title"><Icon name="key" size={15} /> Authentication</strong>
        {credentials.length ? <>
          {credentials.map((credential) => <label className="request-input" key={credential.key}>
            <span>{credential.name}<small>{credential.location} · used by {plural(credential.operationKeys.length, "endpoint")}</small></span>
            <input type="password" autoComplete="off" value={credentialValues[credential.key] ?? ""} onChange={(event) => onCredentialChange(credential.key, event.target.value)} placeholder={credential.name.toLowerCase() === "authorization" ? "Bearer eyJhbGciOi…" : `Enter ${credential.name}`} />
            <small className="request-input-help">{credential.description ? `${credential.description} ` : ""}An endpoint's own value, entered in its request details, takes precedence.</small>
          </label>)}
          <label className="connection-panel-check"><input type="checkbox" checked={remember} onChange={(event) => onRememberChange(event.target.checked)} /> Remember in this tab until it is closed</label>
          <small className="connection-panel-note">Credentials are never saved to the workspace, run evidence, or exports.{remember ? " They are kept in this tab's session storage so a reload keeps them." : " Reloading the page clears them."}</small>
        </> : <p className="connection-panel-note">This contract documents no authentication. If the API needs a key or token, enter it on each endpoint as a header parameter, or add a security scheme to the contract.</p>}
      </div>
    </div>
    {credentials.length > 0 && candidates.length > 0 && <div className="connection-panel-signin">
      {showSignIn ? <>
        <div className="connection-panel-signin-heading"><strong>Get a token from a sign-in request</strong><small>Send it once; the token from the response fills {targetCredential?.name ?? "the credential"} for every endpoint.</small></div>
        <div className="connection-panel-signin-grid">
          <label className="request-input"><span>Sign-in endpoint</span><select value={operationKey} onChange={(event) => { onSignInBodyChange(null); changeSignIn({ operationKey: event.target.value }); }}>{candidates.map((key) => <option key={key} value={key}>{key}</option>)}</select></label>
          {credentials.length > 1 && <label className="request-input"><span>Use the token as</span><select value={targetCredential?.key} onChange={(event) => changeSignIn({ credentialKey: event.target.value })}>{credentials.map((credential) => <option key={credential.key} value={credential.key}>{credential.name} ({credential.location})</option>)}</select></label>}
          <label className="request-input"><span>Request body<small>JSON · not saved</small></span><textarea rows="4" value={bodyText} onChange={(event) => onSignInBodyChange(event.target.value)} placeholder={"{\n  \"email\": \"qa@example.com\",\n  \"password\": \"…\"\n}"} /></label>
          <label className="request-input"><span>Token location<small>optional JSON Pointer</small></span><input value={signIn?.tokenPointer ?? ""} onChange={(event) => changeSignIn({ tokenPointer: event.target.value })} placeholder="Found automatically, e.g. /access_token" /></label>
        </div>
        <ErrorAlert message={status.error} />
        {status.message && <div className="alert success-alert" role="status"><Icon name="check" size={16} /><span>{status.message}</span></div>}
        <div className="connection-panel-actions">
          <button className="text-button" type="button" onClick={() => setShowSignIn(false)}>Hide</button>
          <button className="primary-button" type="button" disabled={status.loading} onClick={runSignIn}>{status.loading ? <><span className="spinner" /> Signing in…</> : <>Sign in</>}</button>
        </div>
      </> : <button className="text-button" type="button" onClick={() => setShowSignIn(true)}>Get a token from a sign-in request instead</button>}
    </div>}
  </section>;
}
