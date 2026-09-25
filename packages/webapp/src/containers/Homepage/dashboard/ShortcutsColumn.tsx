import { Tooltip2 } from '@blueprintjs/popover2';
import { useId } from 'react';
import { Link } from 'react-router-dom';
import { useFilterShortcutBoxesSection } from '../components';
import {
  accountsPayable,
  accountsReceivable,
  financialAccounting,
  productsServices,
} from '@/constants/homepageOptions';

const SECTIONS = [
  ...accountsReceivable,
  ...accountsPayable,
  ...financialAccounting,
  ...productsServices,
];

/**
 * The homepage shortcuts as a column beside the dashboard: a pill per
 * destination under its section heading. What used to be each card's
 * description is now a tooltip, shown on hover and on keyboard focus. Sections
 * are filtered by the user's permissions, as before.
 */
export function ShortcutsColumn() {
  const titleId = useId();
  const sections = useFilterShortcutBoxesSection(SECTIONS);

  if (sections.length === 0) return null;

  return (
    <aside className="dash-shortcuts" aria-labelledby={titleId}>
      <h2 className="dash-shortcuts__title" id={titleId}>
        Shortcuts
      </h2>

      {sections.map(({ sectionTitle, shortcuts }, index) => (
        <section className="dash-shortcuts__section" key={index}>
          <h3 className="dash-shortcuts__heading">{sectionTitle}</h3>
          <ul className="dash-shortcuts__list">
            {shortcuts.map((shortcut) => (
              <li key={shortcut.link}>
                <Tooltip2
                  content={<span>{shortcut.description}</span>}
                  placement="left"
                  hoverOpenDelay={250}
                  popoverClassName="dash-tooltip"
                  minimal
                >
                  <Link
                    className="dash-pill dash-pill--small"
                    to={shortcut.link}
                  >
                    {shortcut.title}
                  </Link>
                </Tooltip2>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </aside>
  );
}
