import { useId } from 'react';
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

interface WidgetCardProps {
  title: string;
  /** Link to the full report behind the widget. */
  action?: { label: string; to: string };
  isLoading: boolean;
  error?: unknown;
  onRetry?: () => void;
  /** True when the report loaded but has nothing to draw for this range. */
  isEmpty?: boolean;
  emptyText?: string;
  /** What to do about an empty widget, e.g. create the first invoice. */
  emptyAction?: { label: string; to: string };
  /** Grid width on wide screens. */
  size?: 'wide' | 'narrow' | 'half';
  children: ReactNode;
}

const isForbidden = (error: unknown): boolean => {
  const status =
    (error as { status?: number; response?: { status?: number } })?.status ??
    (error as { response?: { status?: number } })?.response?.status;
  return status === 403;
};

/**
 * Shell shared by every dashboard widget: title, link to the source report,
 * and the loading / error / empty states, so each widget only draws its data.
 */
export function WidgetCard({
  title,
  action,
  isLoading,
  error,
  onRetry,
  isEmpty = false,
  emptyText = 'Nothing to show for this period yet.',
  emptyAction,
  size = 'half',
  children,
}: WidgetCardProps) {
  const titleId = useId();

  return (
    <section
      className={`dash-card dash-card--${size}`}
      aria-labelledby={titleId}
      aria-busy={isLoading}
    >
      <header className="dash-card__header">
        <h2 className="dash-card__title" id={titleId}>
          {title}
        </h2>
        {action && (
          <Link className="dash-card__action" to={action.to}>
            {action.label}
          </Link>
        )}
      </header>

      {isLoading ? (
        <div className="dash-skeleton" aria-hidden="true">
          <span className="dash-skeleton__line dash-skeleton__line--short" />
          <span className="dash-skeleton__line" />
          <span className="dash-skeleton__block" />
        </div>
      ) : error ? (
        <div className="dash-card__message" role="alert">
          <p>
            {isForbidden(error)
              ? "You don't have permission to view this report."
              : "This report couldn't be loaded."}
          </p>
          {onRetry && !isForbidden(error) && (
            <button
              type="button"
              className="dash-pill dash-pill--small"
              onClick={onRetry}
            >
              Try again
            </button>
          )}
        </div>
      ) : isEmpty ? (
        <div className="dash-card__message">
          <p>{emptyText}</p>
          {emptyAction && (
            <Link className="dash-pill dash-pill--small" to={emptyAction.to}>
              {emptyAction.label}
            </Link>
          )}
        </div>
      ) : (
        children
      )}
    </section>
  );
}
