// Small ring showing the share of an API's endpoints tested in this browser, with a red dot
// when an endpoint failed in its latest run. Used as the API's tile on the API specs page.
const RADIUS = 27;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

export default function CoverageRing({ totals }) {
  const percent = totals.coveragePercent;
  const label = `${totals.tested} of ${totals.endpoints} endpoints tested (${percent}%)${totals.failing ? `, ${totals.failing} failing` : ""}`;
  return <span className="coverage-ring" role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 64 64" aria-hidden="true">
      <circle className="coverage-ring-track" cx="32" cy="32" r={RADIUS} />
      {percent > 0 && <circle
        className="coverage-ring-value"
        cx="32"
        cy="32"
        r={RADIUS}
        strokeDasharray={`${(percent / 100) * CIRCUMFERENCE} ${CIRCUMFERENCE}`}
      />}
    </svg>
    <span className="coverage-ring-text">{percent}%</span>
    {totals.failing > 0 && <span className="coverage-ring-alert" aria-hidden="true" />}
  </span>;
}
