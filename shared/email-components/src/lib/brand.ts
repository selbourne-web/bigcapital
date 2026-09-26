/**
 * Selbourne Financial brand tokens for outbound email.
 *
 * Mirrors packages/webapp/DESIGN.md. Email clients cannot read CSS variables,
 * so every value is a literal. Fonts are system stacks with fallbacks, because
 * most clients ignore web fonts.
 */
export const BRAND = {
  name: 'Selbourne Financial',

  primary: '#800000',
  ink: '#000000',
  charcoal: '#4c4c4c',
  slate: '#727272',
  page: '#ececec',
  paper: '#ffffff',
  hairline: '#dcdcdc',

  cardRadius: '28px',
  pillRadius: '999px',

  displayFont:
    "Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Narrow', sans-serif",
  bodyFont: "Tahoma, Verdana, 'Segoe UI', Arial, sans-serif",
} as const;
