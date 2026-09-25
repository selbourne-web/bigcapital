// @ts-nocheck
import React from 'react';
import { Scrollbar } from 'react-scrollbars-custom';
import { useObserveSidebarExpendedBodyclass } from './hooks';

/**
 * Sidebar container. The sidebar is a fixed-width icon rail, so it no longer
 * expands or collapses.
 * @returns {JSX.Element}
 */
export function SidebarContainer({ children }) {
  // The rail is never a "mini" sidebar; clear any stale body class.
  useObserveSidebarExpendedBodyclass(true);

  return (
    <div className="sidebar sidebar--rail" id="sidebar">
      <div className={'sidebar__scroll-wrapper'}>
        <Scrollbar noDefaultStyles={true}>
          <div className="sidebar__inner">{children}</div>
        </Scrollbar>
      </div>
    </div>
  );
}
