import Icon, { type IconName } from "./Icon";
export default function EmptyState({
  icon,
  title,
  description,
  href,
  label,
}: {
  icon: IconName;
  title: string;
  description: string;
  href?: string;
  label?: string;
}) {
  return (
    <section className="card empty-state">
      <span className="empty-icon">
        <Icon name={icon} size={30} />
      </span>
      <h2>{title}</h2>
      <p className="muted">{description}</p>
      {href && (
        <a className="button secondary" href={href}>
          {label}
          <Icon name="arrow" size={17} />
        </a>
      )}
      <span className="preview-label">Workspace preview</span>
    </section>
  );
}
