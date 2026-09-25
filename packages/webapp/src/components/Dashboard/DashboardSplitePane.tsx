import React from 'react';
import SplitPane from 'react-split-pane';

interface DashboardSplitPaneProps {
  children?: React.ReactNode;
}

interface SplitPaneWithChildrenProps {
  allowResize?: boolean;
  split?: 'vertical' | 'horizontal';
  minSize?: number | string;
  maxSize?: number | string;
  defaultSize?: number | string;
  size?: number | string;
  className?: string;
  children?: React.ReactNode;
}

const SplitPaneComponent =
  SplitPane as unknown as React.ComponentType<SplitPaneWithChildrenProps>;

// Width of the icon rail (keep in sync with `$sidebar-rail-width` in Sidebar.scss).
const SIDEBAR_RAIL_WIDTH = 84;

export default function DashboardSplitPane({
  children,
}: DashboardSplitPaneProps) {
  return (
    <SplitPaneComponent
      allowResize={false}
      split="vertical"
      minSize={SIDEBAR_RAIL_WIDTH}
      maxSize={SIDEBAR_RAIL_WIDTH}
      defaultSize={SIDEBAR_RAIL_WIDTH}
      size={SIDEBAR_RAIL_WIDTH}
      className="primary"
    >
      {children}
    </SplitPaneComponent>
  );
}
