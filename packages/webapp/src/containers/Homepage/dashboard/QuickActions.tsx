import { Icon } from '@blueprintjs/core';
import { Link } from 'react-router-dom';

const ACTIONS = [
  { label: 'Create invoice', to: '/invoices/new' },
  { label: 'Create estimate', to: '/estimates/new' },
  { label: 'Add customer', to: '/customers/new' },
  { label: 'Record expense', to: '/expenses/new' },
  { label: 'Create receipt', to: '/receipts/new' },
  { label: 'Add bill', to: '/bills/new' },
];

/** Pill shortcuts to the most common "create" screens. */
export function QuickActions() {
  return (
    <nav className="dash-actions" aria-label="Quick actions">
      {ACTIONS.map((action) => (
        <Link key={action.to} className="dash-pill" to={action.to}>
          <Icon icon="plus" size={12} />
          {action.label}
        </Link>
      ))}
    </nav>
  );
}
