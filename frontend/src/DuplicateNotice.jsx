import Icon from "./Icon.jsx";

const sourceLabels = { contract: "contract check", ai_edited: "edited AI check", ai: "AI idea" };
const sourceOf = (scenario) => scenario.source ?? "contract";

export default function DuplicateNotice({ pairs, scenarios, disabled, onDrop, onKeepBoth }) {
  if (!pairs.length) return null;
  return <section className="duplicate-notice" aria-label="Possible duplicate scenarios">
    <div className="duplicate-notice-heading">
      <Icon name="spark" size={14} />
      <strong>Possible duplicates · {pairs.length}</strong>
      <span>Scenarios that seem to test the same thing. Removing one keeps the list focused.</span>
    </div>
    <ul>{pairs.map((pair) => {
      const drop = scenarios[pair.drop];
      const keep = scenarios[pair.keep];
      const dropSource = sourceOf(drop);
      return <li key={`${pair.keep}-${pair.drop}`}>
        <p>
          <b>{drop.title}</b> <small>({sourceLabels[dropSource]})</small> looks like <b>{keep.title}</b> <small>({sourceLabels[sourceOf(keep)]})</small>.
          <span className="duplicate-reason">{pair.reason.text}</span>
        </p>
        <div className="duplicate-actions">
          <button className="text-button danger" type="button" disabled={disabled} onClick={() => onDrop(pair)}>{dropSource === "ai" ? "Dismiss idea" : "Remove check"}</button>
          <button className="text-button" type="button" disabled={disabled} onClick={() => onKeepBoth(pair)}>Keep both</button>
        </div>
      </li>;
    })}</ul>
  </section>;
}
