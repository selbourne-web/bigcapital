import classNames from 'classnames';
import React from 'react';
import { SelbourneLogo } from '@/components/Branding/SelbourneLogo';
import { useIsDarkMode } from '@/hooks/useDarkMode';

import '@/style/components/BigcapitalLoading.scss';

interface BigcapitalLoadingProps {
  className?: string;
}

/**
 * Full-screen logo loading. (File name kept from upstream; it shows the
 * Selbourne logo.)
 */
export default function BigcapitalLoading({
  className,
}: BigcapitalLoadingProps) {
  const isDarkmode = useIsDarkMode();

  return (
    <div className={classNames('bigcapital-loading', className)}>
      <div className="center">
        <SelbourneLogo width={228} onDark={isDarkmode} />
      </div>
    </div>
  );
}
