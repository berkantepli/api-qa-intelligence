import { useState } from "react";
import Icon from "./Icon.jsx";

const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const SOURCE_LABELS = { postman: "Postman collection", har: "HAR file" };

// What a Postman collection or HAR file covers of the contract, and filling request details from it.
export default function RequestImportPanel({ collection, comparison, onApply, onOpenEndpoint, onClose, applied }) {
  const [replace, setReplace] = useState(false);
  const { matched, unmatched, uncovered, total } = comparison;
  const withValues = matched.filter((item) => item.suggestedCount > 0);
  return <section className="panel request-import-panel" aria-label="Imported requests">
    <div className="quality-heading">
      <div className="quality-intro">
        <h2>{collection.name}</h2>
        <p>{SOURCE_LABELS[collection.source]} · {plural(collection.requests.length, "request")}
          {collection.skipped > 0 && ` · ${collection.skipped} entries that are not API requests skipped`}
          {collection.left_out_secrets > 0 && ` · ${plural(collection.left_out_secrets, "credential-like value")} left out`}
          {collection.too_long > 0 && ` · ${collection.too_long} too long to read (paths over 2,000 characters, values over 2,000, bodies over 200,000) left out`}.
          Headers, auth settings, and cookies are never read.</p>
      </div>
      <button className="icon-button" type="button" onClick={onClose} aria-label="Close imported requests"><Icon name="close" size={15} /></button>
    </div>

    {collection.requests.length === 0 && <div className="alert error-alert" role="status"><Icon name="close" size={16} /><span>The file has no API requests{collection.source === "har" ? " (only fetch and XHR calls count; scripts, styles, and images are skipped)" : ""}, so there is nothing to compare. {collection.source === "har" ? "Record the HAR while using the app, with the Network tab open." : "Choose a collection that contains requests."}</span></div>}
    <div className="stats-row request-import-stats">
      <div className="stat-card"><span className="stat-label">Endpoints it calls</span><strong>{matched.length} / {total}</strong><span className="stat-note">{total ? Math.round((matched.length / total) * 100) : 0}% of the contract</span></div>
      <div className="stat-card"><span className="stat-label">Never called</span><strong className={uncovered.length ? "coverage-warning" : undefined}>{uncovered.length}</strong><span className="stat-note">endpoints in the contract</span></div>
      <div className="stat-card"><span className="stat-label">Not in the contract</span><strong className={unmatched.length ? "coverage-warning" : undefined}>{unmatched.length}</strong><span className="stat-note">{unmatched.length === 1 ? "request" : "requests"} to undocumented paths</span></div>
    </div>

    {withValues.length > 0 && <div className="request-import-apply">
      <div>
        <h3>Use its values as request details</h3>
        <p>Fills path and query parameters and body fields of {plural(withValues.length, "endpoint")} with the values the file sends. Credentials are never filled.</p>
        <label className="flow-edit-check"><input type="checkbox" checked={replace} onChange={(event) => setReplace(event.target.checked)} /><span>Replace values I already entered</span></label>
      </div>
      <button className="primary-button" type="button" onClick={() => onApply(replace)}><Icon name="check" size={14} /> Fill request details</button>
    </div>}
    {applied && <div className="alert success-alert" role="status"><Icon name="check" size={16} /><span>{applied}</span></div>}

    <div className="quality-findings">
      {uncovered.length > 0 && <details open={uncovered.length <= 8}>
        <summary><strong>Endpoints the file never calls</strong><small>{uncovered.length}</small></summary>
        <ul className="request-import-list">{uncovered.map((operation) => <li key={`${operation.method} ${operation.path}`}>
          <span className={`method-tag method-${operation.method.toLowerCase()}`}>{operation.method}</span><code>{operation.path}</code>
          <button className="text-button" type="button" onClick={() => onOpenEndpoint(operation)}>Open</button>
        </li>)}</ul>
      </details>}
      {unmatched.length > 0 && <details>
        <summary><strong>Requests to paths the contract does not document</strong><small>{unmatched.length}</small></summary>
        <ul className="request-import-list">{unmatched.map((request, index) => <li key={index}>
          <span className={`method-tag method-${request.method.toLowerCase()}`}>{request.method}</span><code>{request.path}</code><small>{request.name}</small>
        </li>)}</ul>
      </details>}
      {matched.length > 0 && <details>
        <summary><strong>Endpoints it calls</strong><small>{matched.length}</small></summary>
        <ul className="request-import-list">{matched.map((item) => <li key={`${item.operation.method} ${item.operation.path}`}>
          <span className={`method-tag method-${item.operation.method.toLowerCase()}`}>{item.operation.method}</span><code>{item.operation.path}</code>
          <small>{plural(item.requests.length, "request")}{item.suggestedCount ? ` · ${plural(item.suggestedCount, "value")}` : ""}</small>
          <button className="text-button" type="button" onClick={() => onOpenEndpoint(item.operation)}>Open</button>
        </li>)}</ul>
      </details>}
    </div>
  </section>;
}
