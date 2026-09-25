---
name: Selbourne Financial
description: Self-hosted accounting for Selbourne, laid out like a maroon-bound ledger with white pages and pill controls.
colors:
  maroon: "#800000"
  maroon-hover: "#950000"
  ember: "#d40000"
  cellar: "#280b0b"
  ink: "#000000"
  charcoal: "#4c4c4c"
  slate: "#727272"
  page: "#ececec"
  paper: "#ffffff"
  hairline: "#dcdcdc"
  rose: "#c15a5a"
  blush: "#e3b3b3"
  maroon-on-dark: "#f4746b"
typography:
  display:
    fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Narrow', sans-serif"
    fontSize: "36px"
    fontWeight: 400
    lineHeight: 1.1
    letterSpacing: "0.01em"
  headline:
    fontFamily: "Impact, Haettenschweiler, 'Arial Narrow Bold', 'Arial Narrow', sans-serif"
    fontSize: "30px"
    fontWeight: 400
    lineHeight: 1.15
    letterSpacing: "0.01em"
  title:
    fontFamily: "Tahoma, Verdana, 'Segoe UI', system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 700
    lineHeight: 1.3
  body:
    fontFamily: "Tahoma, Verdana, 'Segoe UI', system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.55
  label:
    fontFamily: "'Aptos Narrow', 'Arial Narrow', 'Roboto Condensed', Tahoma, sans-serif"
    fontSize: "12px"
    fontWeight: 600
    lineHeight: 1.3
rounded:
  pill: "999px"
  card: "28px"
  tile: "18px"
  tooltip: "16px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "32px"
components:
  pill-button:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.pill}"
    padding: "7px 16px"
  pill-button-hover:
    textColor: "{colors.maroon}"
  button-primary:
    backgroundColor: "{colors.maroon}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    padding: "8px 18px"
  card:
    backgroundColor: "{colors.paper}"
    textColor: "{colors.ink}"
    rounded: "{rounded.card}"
    padding: "22px 26px 26px"
  rail-item-active:
    backgroundColor: "{colors.maroon}"
    textColor: "{colors.paper}"
    rounded: "{rounded.pill}"
    size: "52px"
    height: "32px"
---

# Design System: Selbourne Financial

<!-- Provisional. Scan-mode record of what is built in `packages/webapp` (2026-09-24). The creative language (north star, philosophy, named rules) was proposed by the assistant under the owner's delegation; the palette, fonts, pill/rounded direction, light theme and QuickBooks-style rail/dashboard are the owner's confirmed decisions. Revise the language freely. -->

## Overview

**Creative North Star: "The Maroon Ledger"**

A well-kept ledger: a maroon binding, clean white pages, and everything on the page legible at a glance. The maroon is the binding and the pen, not the paper: it appears on the active place in the rail, on links and primary actions, and on the lead series in a chart. The paper is white cards on a light gray desk. Numbers are the content, so they get the display face; everything else stays quiet.

The system is light, rounded and calm. Controls are pills, containers are generously rounded cards, and charts draw with soft rounded marks, so nothing on screen has a hard corner except data tables, where alignment matters more than shape. Density is moderate: this is a desktop tool used in long sessions, so figures and labels are compact but never cramped.

Familiarity matters more than novelty. The layout follows QuickBooks Online where it has an established pattern (icon rail with flyouts, quick-action pills, business-at-a-glance cards), because the team already knows how to read it.

**Key Characteristics:**
- Light gray page, white cards, black text; maroon as the single accent.
- Pill controls and 28px cards; rounded marks in charts.
- Impact for headline figures and page greetings, Tahoma for reading, Aptos Narrow for dense data labels.
- Charts are drawn from theme tokens (`--chart-*`), never one-off colours.
- Motion is one authored moment per chart, and off under `prefers-reduced-motion`.

## Colors

A maroon accent on neutral grays, with two supporting reds for chart series.

### Primary
- **Ledger Maroon** (`colors.maroon`): links, primary buttons, the active rail item, the lead chart series, focus rings. Hover is **Deep Ember** (`colors.maroon-hover`).
- **Bright Ember** (`colors.ember`): the accent on dark surfaces and the dark-theme primary. Not used as text on white.

### Secondary
- **Rose** (`colors.rose`) and **Blush** (`colors.blush`): supporting chart series and older-debt shading. Derived from the brand red, not part of the supplied palette.

### Neutral
- **Ink** (`colors.ink`): all body text in the light theme.
- **Charcoal** (`colors.charcoal`) and **Slate** (`colors.slate`): secondary text, axis labels, icons. Charcoal is the default secondary; Slate is for de-emphasised text on white only.
- **Desk** (`colors.page`): the page background behind cards.
- **Paper** (`colors.paper`): cards, the rail, the topbar.
- **Hairline** (`colors.hairline`): rail edge, pill borders, gridlines.
- **Cellar** (`colors.cellar`): the darkest brand tone; reserved for the dark theme and brand surfaces.
- **Maroon on Dark** (`colors.maroon-on-dark`): link text in the dark theme, where Maroon would not have enough contrast.

### Named Rules
**The Binding Rule.** Maroon marks where you are and what you can act on. It never fills a large area, and it is never the colour of a plain data series unless that series is the lead one.
**The Two-Tone Series Rule.** Paired series differ in lightness as well as hue (maroon against mid gray), so they stay distinguishable without colour vision.

## Typography

**Display Font:** Impact (fallbacks: Haettenschweiler, Arial Narrow Bold)
**Body Font:** Tahoma (fallbacks: Verdana, Segoe UI, system-ui)
**Label/Data Font:** Aptos Narrow (fallbacks: Arial Narrow, Roboto Condensed, Tahoma)

**Character:** Impact gives headline figures the weight of a printed ledger total; Tahoma keeps sentences plain and readable at small sizes; the narrow face fits axis labels, legends and tabular numbers into small spaces.

Impact and Aptos Narrow are installed system fonts, not webfonts, so each stack ends in installed condensed faces. No font files are shipped.

### Hierarchy
- **Display** (Impact 400, 36px, 1.1): headline figures in dashboard widgets (net profit, cash, totals).
- **Headline** (Impact 400, 30px, 1.15): the homepage greeting and section headings.
- **Title** (Tahoma 700, 15px, 1.3): widget and card titles.
- **Body** (Tahoma 400, 13px, 1.55): descriptions, empty-state text, control labels. Keep sentences to about 38ch inside cards.
- **Label** (Aptos Narrow 600, 12px): KPI captions, axis ticks, legends, tooltips, table-like values. Numerals are tabular.

### Named Rules
**The Figures-First Rule.** Only numbers and the page greeting use the display face. Headings inside cards stay in Tahoma.

**Rollout status.** The brand fonts are applied on the homepage dashboard and its charts. The rest of the app still uses the upstream stack (Noto Sans); adopting Tahoma as the global body font is a pending decision.

## Layout

A fixed 84px icon rail on the left, a topbar with the page title and quick actions, and a scrolling content area on a light gray desk. The homepage has two columns: the report widgets on the left and a 300px Shortcuts column on the right (sticky, and stacked below the widgets under 1100px viewport width). The widgets sit on a 12-column grid with 20px gaps: Profit and loss (5) beside Income and expenses (7), Cash flow (7) beside Expenses (5), then two half-width aging cards; the widgets stack when their own grid is narrower than 780px (a container query, since the shortcuts column shares the row). Page padding is 32px; content is capped at 1800px. The layout targets desktop widths (host minimum 850px content); phones are not supported.

## Elevation & Depth

Hybrid: flat surfaces separated by tone (white cards on the gray desk), with a soft two-layer shadow on cards and floating panels.

### Shadow Vocabulary
- **Card** (`box-shadow: 0 1px 2px rgba(0,0,0,0.06), 0 6px 18px rgba(0,0,0,0.05)`): homepage cards and dashboard widgets at rest.
- **Card lift** (`box-shadow: 0 2px 4px rgba(0,0,0,0.08), 0 12px 28px rgba(0,0,0,0.1)`, translateY(-2px)): shortcut cards on hover.
- **Floating** (`box-shadow: 0 2px 4px rgba(0,0,0,0.08), 0 12px 28px rgba(0,0,0,0.14)`): chart tooltips; the rail flyout uses the same recipe.

### Named Rules
**The Soft-Blur Rule.** Every shadow has an offset and a blur. No zero-blur hard shadows and no coloured glows.

## Shapes

Rounded is the house form. Pills (`rounded.pill`, 999px) for buttons, chips, selects, rail icon tiles, list rows on hover and progress tracks; 28px for cards; 24px on the right edge of the rail flyout; 16px for tooltips; small radii (6px) only on bar tops and donut segment ends. Data tables and form inputs keep the upstream square-ish corners.

## Components

### Buttons and pills
- **Shape:** full pill (999px).
- **Default pill:** white on the gray desk, 1px hairline border, black text (padding 7px 16px). Hover turns border and text maroon.
- **Primary:** maroon fill, white text; hover uses Deep Ember.
- **Focus:** 2px maroon outline, 2px offset, on every interactive element.

### Cards / Containers
- **Corner Style:** 28px. **Background:** paper. **Shadow:** Card. **Border:** none. **Padding:** 22px 26px 26px.
- Whole-card links use a stretched title link so the entire card is the target.

### Navigation (icon rail)
- Fixed 84px, white with a hairline right edge. Each item is a 52x32 pill holding a 20px Blueprint icon, over an 11px label. Hover tints the pill; active fills it maroon with a white icon and a bold label.
- Only the open flyout's item is active while a flyout is open; otherwise the current page or section is. Group headings become hairlines.
- The Selbourne mark at the top opens the workspace switcher.

### Shortcuts column
- A card at the right of the dashboard titled "Shortcuts", with the four section headings (Accounts Receivable, Accounts Payable, Financial Accounting, Products, Services & Inventory). Under each heading, small pill links that wrap. The description that used to fill each shortcut card is a tooltip (same surface as chart tooltips), opened by hover or keyboard focus. Sections follow the user's permissions.

### Date range
- A pill-shaped native select, with two date inputs for "Custom range", and the resolved dates beside it.

### Charts
- Composition: grid, series, axes, tooltip layer. One root per chart. Colours only from `--chart-1` to `--chart-5`.
- Line and area: 2.5px round-cap line, gradient fill. Bars: rounded tops. Donut: 22px ring with a value in the centre and a legend.
- Hover and keyboard (arrow keys) reveal a crosshair or band and a tooltip; a live region announces the focused point.
- Enter animation: 1100ms exponential ease-out reveal, once per data change.

### Empty and error states
- A plain sentence and, when there is an obvious next step, one pill action (for example "Create an invoice"). Errors offer "Try again"; missing permission says so.

## Do's and Don'ts

### Do:
- **Do** use maroon only for place, action and the lead data series.
- **Do** show figures in whole units on headline numbers and legends; keep full precision in tooltips.
- **Do** theme charts through `--chart-*` variables so light and dark stay in step.
- **Do** keep every interactive element keyboard-reachable with the maroon focus ring.
- **Do** compile all SCSS after changing colours to CSS variables: Sass colour functions (`lighten`, `rgba(...)` on a value, colour maps) need literal colours, and email or portal defaults cannot use CSS variables.

### Don't:
- **Don't** use blue for links, focus or selection; the upstream Blueprint blues have been replaced with the brand reds.
- **Don't** put an eyebrow label above a heading, or number sections.
- **Don't** use hard offset shadows or coloured glows.
- **Don't** show fabricated figures anywhere a user could mistake them for their books; sample data is development-only and always labelled.
- **Don't** ship Impact or Aptos Narrow as font files; they are system fonts with condensed fallbacks.
