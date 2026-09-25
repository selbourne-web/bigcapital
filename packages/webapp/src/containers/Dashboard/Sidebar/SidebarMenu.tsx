// @ts-nocheck
import { Icon } from '@blueprintjs/core';
import classNames from 'classnames';
import React from 'react';
import { useLocation } from 'react-router-dom';
import { useIsSidebarMenuItemActive } from './hooks';
import { SidebarMenu as SIDEBAR_MENU_ITEMS } from '@/constants/sidebarMenu';
import {
  ISidebarMenuItemType,
  ISidebarMenuOverlayIds,
} from '@/containers/Dashboard/Sidebar/interfaces';
import { useSidebarSubmenu } from '@/hooks/state';

// Every route reachable from each overlay (flyout), so the rail can highlight
// the section the current page belongs to.
const collectHrefs = (items = []) =>
  items.flatMap((child) => [
    ...(child.href ? [child.href] : []),
    ...collectHrefs(child.children),
  ]);
const OVERLAY_HREFS = SIDEBAR_MENU_ITEMS.flatMap(function walk(item) {
  return item.type === ISidebarMenuItemType.Overlay
    ? [[item.overlayId, collectHrefs(item.children)]]
    : (item.children || []).flatMap(walk);
}).reduce((acc, [id, hrefs]) => ({ ...acc, [id]: hrefs }), {});

const isOnRoute = (pathname, href, exact = false) =>
  !!href &&
  (pathname === href ||
    (!exact && href !== '/' && pathname.startsWith(`${href}/`)));

// Rail icons, keyed by overlay id, falling back to the item href.
const RAIL_ICON_BY_OVERLAY = {
  [ISidebarMenuOverlayIds.Items]: 'cube',
  [ISidebarMenuOverlayIds.Sales]: 'shopping-cart',
  [ISidebarMenuOverlayIds.Purchases]: 'shop',
  [ISidebarMenuOverlayIds.Contacts]: 'people',
  [ISidebarMenuOverlayIds.Financial]: 'bank-account',
  [ISidebarMenuOverlayIds.Cashflow]: 'exchange',
  [ISidebarMenuOverlayIds.Expenses]: 'credit-card',
  [ISidebarMenuOverlayIds.Reports]: 'timeline-bar-chart',
};
const RAIL_ICON_BY_HREF = {
  '/': 'home',
  '/preferences': 'cog',
};
const RAIL_ICON_FALLBACK = 'circle';

const getRailIcon = (item) =>
  RAIL_ICON_BY_OVERLAY[item.overlayId] ||
  RAIL_ICON_BY_HREF[item.href] ||
  RAIL_ICON_FALLBACK;

/**
 * Sidebar rail item: icon in a pill over a short label.
 * @returns {JSX.Element}
 */
function SidebarMenuItem({ item }) {
  const { pathname } = useLocation();
  const { submenuId } = useSidebarSubmenu();

  const isOverlayOpen = useIsSidebarMenuItemActive(item);
  const isCurrentRoute = isOnRoute(pathname, item.href, item.matchExact);
  const isInSection = (OVERLAY_HREFS[item.overlayId] || []).some((href) =>
    isOnRoute(pathname, href),
  );

  // While a flyout is open only its item reads as active; otherwise the item
  // for the current page or section does.
  const isActive = submenuId ? isOverlayOpen : isCurrentRoute || isInSection;

  // Mouse clicks shouldn't leave a focus ring behind; keyboard activation
  // (detail === 0) keeps focus so keyboard users don't lose their place.
  const releaseFocusOnMouseClick = (event) => {
    if (event.detail > 0) event.currentTarget.blur();
  };

  const className = classNames('sidebar-rail__item', {
    'is-active': isActive,
    'is-disabled': item.disabled,
  });
  const content = (
    <>
      <span className="sidebar-rail__icon">
        <Icon icon={getRailIcon(item)} size={20} />
      </span>
      <span className="sidebar-rail__label">{item.text}</span>
    </>
  );

  if (item.href && item.type === ISidebarMenuItemType.Link) {
    return (
      <a
        href={item.href}
        className={className}
        aria-current={isCurrentRoute ? 'page' : undefined}
        onClick={(event) => {
          // Keep modified clicks (new tab / window) native; route the rest in-app.
          if (event.metaKey || event.ctrlKey || event.shiftKey) return;
          event.preventDefault();
          releaseFocusOnMouseClick(event);
          if (!item.disabled) item.onClick?.(event);
        }}
      >
        {content}
      </a>
    );
  }
  return (
    <button
      type="button"
      className={className}
      disabled={item.disabled}
      aria-expanded={
        item.type === ISidebarMenuItemType.Overlay ? isOverlayOpen : undefined
      }
      onClick={(event) => {
        releaseFocusOnMouseClick(event);
        item.onClick?.(event);
      }}
    >
      {content}
    </button>
  );
}

/**
 * Renders one entry of the main menu: an item, or a divider for a group.
 * @returns {JSX.Element}
 */
function SidebarMenuItemComposer({ item }) {
  switch (item.type) {
    case ISidebarMenuItemType.Link:
    case ISidebarMenuItemType.Overlay:
    case ISidebarMenuItemType.Dialog:
      return <SidebarMenuItem item={item} />;
    case ISidebarMenuItemType.Group:
      // Group headings don't fit a narrow rail; a hairline keeps the grouping.
      return <div className="sidebar-rail__divider" role="separator" />;
    default:
      return null;
  }
}

/**
 * Sidebar menu.
 * @returns {JSX.Element}
 */
export function SidebarMenu({ menu }) {
  return (
    <nav className="sidebar-rail" aria-label="Main">
      {menu.map((item, index) => (
        <SidebarMenuItemComposer key={index} item={item} />
      ))}
    </nav>
  );
}
