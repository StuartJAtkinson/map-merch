# UX conventions — Heart on a Sleeve

What the frontend actually does today (verified 2026-09-06 against
`frontend/cesium/public/app.css`, `index.html`, `public/{login,landing}.html`
and `src/*.ts`; re-checked 2026-10-10). Reference document — questions go to CONSIDERATIONS.md,
bugs to ISSUES.md.

## Where the design system lives

`frontend/cesium/public/app.css` is the single shared stylesheet; all three HTML entry
points link it (`/app.css`). Anything reused across views belongs there. Per-page
`<style>` blocks are for genuinely local layout only — `index.html`'s is scoped to the
map selector and the three inline viewers.

## Tokens

Dark, blue-accented, defined once in `:root` in `app.css`. Never write a literal where a
token exists.

| Group | Tokens |
|---|---|
| Backgrounds | `--bg-page` #0a0a10 · `--bg-panel` rgba(8,8,14,.96) · `--bg-item` #12121e · `--bg-hover` #1a1a28 |
| Borders | `--border-panel` #38384a · `--border-item` #333345 · `--border-dim` #2a2a38 |
| Text | `--text-primary` #fff · `--text-high` #ddddee · `--text-mid` #aaaacc · `--text-muted` #8888aa · `--text-dim` #666680 · `--text-faint` #44445a |
| Labels | `--text-label` #8a8aaa · `--text-sublabel` #7070a0 |
| Accent | `--accent` #4a9eff · `--accent-soft` rgba(74,158,255,.08) · `--accent-border` rgba(74,158,255,.5) |
| Toggle | `--toggle-track` #333345 · `--toggle-dot` #888899 · `--toggle-on` #4a9eff |
| Status | `--color-danger` #e06060 · `--color-danger-soft` rgba(224,96,96,.08) · `--color-success` #4a9a4a |
| Radii / pad | `--radius-panel` 10px · `--radius-btn` 6px · `--radius-input` 4px · `--panel-pad` 16px |

Body text is `system-ui`; numeric inputs and the bbox readout are `monospace`.

Colours that are **map or print output**, not UI, are deliberately outside this system:
the `STYLES` palettes in `svg_generator.py` / `svg-renderer.ts`, the swatch sets in
`app.ts`, and the Green Party stamp green `#5AB031`.

## Type scale

10px (meta, hints, `.param-desc`, status bar) · 11px (labels, statuses, small buttons) ·
12px (buttons, body rows) · 13px (primary button, inputs, empty states) ·
15–16px (`h2` / panel titles) · 22px (auth page `h1`).
Section heads (`.panel h3`, `.section-label`) are 11px, uppercase, letter-spaced,
`--text-label` / `--text-sublabel`.

## Spacing

No formal scale; the values in use are 2, 4, 5, 6, 7, 8, 10, 14, 16, 18px, and reaching
for one already used nearby is the convention. Fixed points: `--panel-pad` 16px inside
every panel, 7px between stacked `.btn`s (their `margin-top`), 6px between grid tiles,
`.divider` at `8px 0 6px`, `.section` 16px apart.

## Controls

- **`.btn`** — full-width, transparent, 1px `--border-item`, 12px. Hover and the
  selected `.on` / `.active` state both go accent; `.on` also gets `--accent-soft`.
  One `.btn-primary` per view maximum (solid accent) — it's the Generate action.
- **`.btn-secondary`** — the compact inline variant (flex:1, `--text-mid`, 9px 6px),
  used side-by-side in rows such as the user nav; same accent hover as `.btn`. Defined
  in `index.html`'s local `<style>`, not `app.css`.
- **Toggles** are the `.toggle` switch, not checkboxes; the one checkbox
  (`.brand-row`) is a label-wrapped opt-in, and takes `accent-color: var(--accent)`.
- **Inputs** use `--bg-item` on a 1.5px `--border-dim` border that turns `--accent` on
  focus, sized `padding: 8px 10px` · 13px everywhere (`#place-search`, `.save-input`,
  `.brand-select`, login's `.field input`).
- **Icons are emoji/glyph prefixes in the label**, never separate elements:
  💾 Save · ↓ download · ← back · → forward · ⟳ regenerate · ⬡ wireframe · ▶ auto-rotate ·
  ⊞ My Designs · ↩ Logout · 🔍 search · ◉ 3D · 🖨 print.
- **Destructive actions** are `--color-danger` text on a `--border-dim` border, tinting
  to `--color-danger-soft` on hover.

## Panel layout

Every view is one shell: `.panel.sidebar` (280px, `calc(100vh - 22px)`, scrolls) beside
a `.stage` (flexes, `overflow:hidden`). The 22px is the fixed `.app-status-bar`.

Panel order in the three viewers (SVG / 3D / print) is fixed and commented in the markup:
**user nav → save block → status/options → back button at the bottom.** The map panel is
a deliberate exception — it's the entry screen, so its `<h2>` branding leads and the user
nav sits at the bottom.

Back buttons name their destination (`← Map`, `← SVG View`); forward buttons trail an
arrow (`◉ View 3D →`).

## Feedback

- **All progress lives in the status bar** — `.app-status-bar` with `.status-fill`
  (2px accent gradient while `.busy`) and `.status-msg`. Errors set `.errored`, which
  turns both danger-red and holds until the next `Status.begin()`.
- Per-panel status lines are 11px `--text-mid` with a `min-height` so nothing reflows
  when text appears; success/error colour comes from `--color-success` / `--color-danger`.
- Save names are shown, not typed: `.save-name-preview` renders "Saves as: …" as plain
  text (auto-generated from place + merch type).
- ODbL attribution is in the status bar only — never baked into a generated file.

## Terminology

Merch labels come from one map: T-Shirt · Mug · Tote Bag · Coaster · Placemat · Relief
(`3d_print` is the id, "Relief" is the label). Saved work is a **design**; you **Open**
one (not "Load"); **My Designs** is the collection; **Logout** (one word) pairs with **Sign in** (two
words, never "Log in"). The viewer's forward action to the print view is
"🖨 3D Print →" for every 3D type (Coaster, Placemat, Relief) — it names the view, not
the merch.

## Mobile (≤900px)

Sidebars become drag-up bottom sheets: `position:fixed`, full width, `max-height:75vh`,
`border-radius:14px 14px 0 0`, a `.sheet-handle` grip, translated down to a peek and
opened by `.sheet-open`. `.hint` blocks are hidden; touch targets grow (`.cycle-btn`
18px → 32px).
