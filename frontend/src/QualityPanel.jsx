import { useState } from "react";
import Icon from "./Icon.jsx";
import { findingsByEndpoint, qualityTone, ruleLabels } from "./quality.js";

// How testable the active API's contract is: the fixes worth most, every rule, and the findings
// per endpoint. The score comes from fixed rules in the backend, never from AI.
export default function QualityPanel({ quality, operations, onOpenEndpoint, onClose }) {
  const [copied, setCopied] = useState(false);
  const groups = findingsByEndpoint(quality, operations);
  const labels = ruleLabels(quality);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(quality.markdown);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  return <section className="panel quality-panel" aria-label="Contract quality">
    <div className="quality-heading">
      <div className={`quality-score quality-${qualityTone(quality.score)}`}><strong>{quality.score}</strong><span>/ 100</span><b>{quality.grade}</b></div>
      <div className="quality-intro">
        <h2>Contract quality</h2>
        <p>How well this contract supports testing: response schemas, examples, error responses, and limits let the app build and judge more checks. Fixed rules, no AI.</p>
      </div>
      <div className="quality-actions">
        <button className="secondary-button" type="button" onClick={copy}>{copied ? <><Icon name="check" size={14} /> Copied</> : "Copy as Markdown"}</button>
        <button className="icon-button" type="button" onClick={onClose} aria-label="Close contract quality"><Icon name="close" size={15} /></button>
      </div>
    </div>

    {quality.top_fixes.length > 0 && <div className="quality-fixes">
      <h3>Fixes worth most</h3>
      <ol>{quality.top_fixes.map((fix) => <li key={fix.rule}><b>+{fix.points}</b><span>{fix.advice}</span>{fix.endpoints > 0 && <small>{fix.endpoints} {fix.endpoints === 1 ? "endpoint" : "endpoints"}</small>}</li>)}</ol>
    </div>}

    <div className="quality-rules">
      <h3>Rules</h3>
      <ul>{quality.rules.map((rule) => <li key={rule.id} title={rule.description}>
        <span className="quality-rule-label">{rule.label}<small>weight {rule.weight}{rule.applicable ? "" : " · does not apply"}</small></span>
        {rule.score == null ? <span className="quality-rule-na">n/a</span> : <>
          <span className="coverage-meter" aria-hidden="true"><span className={`quality-meter-${qualityTone(rule.score)}`} style={{ width: `${rule.score}%` }} /></span>
          <span className="quality-rule-score">{rule.score}%</span>
        </>}
      </li>)}</ul>
    </div>

    {groups.length > 0 && <div className="quality-findings">
      <h3>Findings</h3>
      {groups.map((group) => <details key={group.key || "api"}>
        <summary>
          {group.method ? <><span className={`method-tag method-${group.method.toLowerCase()}`}>{group.method}</span><code>{group.path}</code></> : <strong>Whole API</strong>}
          <small>{group.findings.length} {group.findings.length === 1 ? "finding" : "findings"}</small>
        </summary>
        <ul>{group.findings.map((finding, index) => <li key={index}><span className="quality-finding-rule">{labels[finding.rule] ?? finding.rule}</span>{finding.message}</li>)}</ul>
        {group.operationIndex >= 0 && <button className="text-button" type="button" onClick={() => onOpenEndpoint(group.operationIndex)}>Open endpoint</button>}
      </details>)}
    </div>}
  </section>;
}
