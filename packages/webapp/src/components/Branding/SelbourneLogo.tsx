import React from 'react';

const LOGO_SRC = '/branding/selbourne-logo.png';
// Intrinsic size of the logo file (411 x 108).
const LOGO_RATIO = 108 / 411;

interface SelbourneLogoProps {
  /** Rendered width in px; height follows the logo's aspect ratio. */
  width?: number;
  /**
   * The wordmark is black, so on dark surfaces it sits on a white rounded
   * plate instead of being recoloured.
   */
  onDark?: boolean;
  className?: string;
}

/**
 * The Selbourne mark and wordmark.
 */
export function SelbourneLogo({
  width = 228,
  onDark = false,
  className,
}: SelbourneLogoProps) {
  const image = (
    <img
      src={LOGO_SRC}
      alt="Selbourne Financial"
      width={width}
      height={Math.round(width * LOGO_RATIO)}
      style={{ display: 'block' }}
      className={onDark ? undefined : className}
    />
  );

  if (!onDark) return image;

  return (
    <span
      className={className}
      style={{
        display: 'inline-block',
        background: '#fff',
        borderRadius: 18,
        padding: '10px 16px',
      }}
    >
      {image}
    </span>
  );
}
