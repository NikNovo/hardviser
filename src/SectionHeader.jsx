// Shared page header used across the app: compact eyebrow + title + optional
// description, with an optional actions slot. See the workspace revision
// contract's "Shared page interface" section for the exact markup contract
// consumed by styles.css (.page-header / .page-header__copy / .page-actions).
export default function SectionHeader({ section, title, description, actions }) {
  return (
    <header className="page-header">
      <div className="page-header__copy">
        {section && <span className="eyebrow">{section}</span>}
        <h1>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {actions && <div className="page-actions">{actions}</div>}
    </header>
  );
}
