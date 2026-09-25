# Product

<!-- impeccable:product-schema 1 -->

<!-- Written 2026-09-24 from the working sessions with the owner, who delegated this file ("create and update the .md files as needed as the design progresses"). No interview round took place. Items marked (inferred) come from repository evidence, not from the owner; confirm or correct them. -->

## Platform

web

## Users

Staff at Selbourne Financial who keep the company's books: invoicing customers, paying bills, recording expenses, reconciling banking, and reading financial reports. The primary user today is the owner and administrator (Scott Griffith). Other roles exist in the product (role-based permissions) but no other audience has been confirmed. (Team size and roles: undecided.)

They work at a desktop browser, on wide screens, in long sessions. The host app enforces an 850px minimum content width; phone layouts are not a target.

## Product Purpose

A self-hosted accounting application for Selbourne Financial, forked from the open-source Bigcapital (AGPL-3.0; upstream `bigcapitalhq/bigcapital`, fork `selbourne-web/bigcapital`). It replaces the upstream look with Selbourne's brand and adds what Selbourne needs, starting with the Barbados dollar (BBD) as a first-class base currency.

Success means the team can run day-to-day bookkeeping in it, and open the homepage to see how the business is doing without opening a report.

## Positioning

Not yet defined by the owner. What is confirmed: it is self-hosted, it is branded and shaped for Selbourne Financial, and the owner wants its navigation and dashboard to feel like QuickBooks Online (reference screenshots in `~/Screenshots`). (Any competitive claim: undecided.)

## Operating Context

- Runs in WSL2 Ubuntu on the owner's Windows machine: API on 3000, webapp on 4000, MariaDB, Redis, ClickHouse, Gotenberg (PDF) and Garage (S3) in Docker.
- Base currency is BBD (`Bds$`). Amounts are formatted by the app's own `formattedAmount` helper.
- Each organization is a tenant with its own database; the owner has one organization, "Selbourne".
- Financial figures on the dashboard come from the report endpoints (profit and loss, cash flow, receivable and payable aging), so they always agree with the reports.

## Capabilities and Constraints

- Frontend: React 18, Vite 5, Blueprint 4, SCSS, styled-components, TanStack Query. No Tailwind. Node is pinned to 18.16.1 and pnpm is the package manager; tools that require Node 20+ (for example the current shadcn CLI) cannot run in this repository.
- Charts are built on visx v3 in `src/components/Charts`, themed through `--chart-*` variables.
- Email (password reset, invites) is configured through Gmail SMTP.
- Dashboard widgets need report permissions; a role without them sees a "no permission" state per widget.
- Terminology follows the product: "Money owed to you" / "Money you owe" for receivables and payables on the dashboard; report names elsewhere are unchanged.
- Undecided: whether dark mode stays supported (light is the default; dark still works with `localStorage.theme = 'dark'`), number of users, hosting beyond the owner's machine.

## Brand Commitments

Confirmed by the owner (assets in `Corp_Branding/` at the repository root, not tracked in git):

- Colours: `#280b0b`, `#800000`, `#d40000`, `#950000`, with accents `#727272`, `#4c4c4c`, `#000000`.
- Fonts: Impact, Tahoma, Aptos Narrow.
- Logo: the Selbourne mark and wordmark (`public/branding/selbourne-logo.png`, `public/logo192.png`).
- Name in the UI: "Selbourne Financial". The upstream "Bigcapital" wordmark is replaced on the sign-in pages.

## Evidence on Hand

- Real: one organization with one customer, one item and one draft invoice (BBD). Not enough data to judge chart designs, so the dashboard has a development-only sample-data preview (`/__preview/dashboard?sample=1`, or `?sample=empty`).
- Reference: QuickBooks Online dashboard screenshot (`~/Screenshots/QuickBooks_Dashboard_Screenshot 2026-09-22 171132.png`).
- Absent, and not to be invented: testimonials, customer counts, benchmarks, pricing, other users.

## Product Principles

1. **The books are the source of truth.** The dashboard summarises reports; it never computes its own numbers or shows figures that disagree with a report.
2. **Familiar before novel.** Where QuickBooks Online has an established pattern (icon rail, quick-action pills, business-at-a-glance widgets), follow it, so the team's habits carry over.
3. **BBD is not an afterthought.** Currency, symbols and formatting come from the organization's base currency everywhere.
4. **Honest empty states.** With little data the dashboard says so and points to the next action; it does not pad itself with placeholders or fake figures. (Confirmed in practice, inferred as a principle.)

## Accessibility & Inclusion

No product-specific standard has been stated. Working assumption (inferred): WCAG 2.1 AA contrast, keyboard operation for every control including the charts, and reduced-motion respected.
