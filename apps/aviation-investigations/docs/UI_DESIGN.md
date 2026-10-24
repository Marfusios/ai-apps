# AirCase: interface design

**Design, agreed 2026-10-21.** The owner chose a direction for each screen from
side-by-side mockups. On 2026-10-24 the owner renamed the product AirCase,
asked for a credit line in the footer, and chose its mark, a plain-language line
for the header and a share card for links (§10). This document replaces the visual
direction in [DESIGN.md §10](DESIGN.md#10-interface-and-dashboard-direction).
Everything else in DESIGN.md stays authoritative, including scope, the AI
pipeline, limits, privacy, and security. Where this document quotes a limit or rule, DESIGN.md wins
if the two ever disagree.

Decisions are marked:

- **Owner:** chosen or approved by the owner.
- **Proposed:** the designer's call. It is open to change, but build it this way
  unless there is a reason not to.
- **Builder:** left to whoever builds it.

The [working mockups](mockups/index.html) show every option considered, with the
chosen one marked. Use them for look and feel; this document is the specification
and wins where they differ. They used real NTSB records and real counts from the
2026-10-16 profile. Counts quoted below are examples of the format, not values to
hard-code.

The builder implements the whole slice: shared Zod contracts, Fastify routes and
the web client. The interface arrives milestone by milestone as DESIGN §13 sets
out:

| Milestone | Interface work |
| --- | --- |
| 1 | Design tokens, frame, home, keyword Explore and the case page |
| 3 | Briefs, checklist, drawer, compare and dashboard |
| 4 | Sign-in, trial, counter states and account |

Contracts for briefs are designed with the API, not mocked separately.

## 1. Intent

The readers are flight instructors preparing case-based lessons, and safety
analysts and student pilots studying past events. They know aviation well and are
not necessarily technical. They will judge the tool on whether they can trust it
in front of a class.

The product should feel like an aviation reference document: a VFR sectional
chart and a printed briefing sheet. It should not feel like a SaaS dashboard or a
chat app. The design should be modern, minimal and memorable, and recognisably
aviation without decorative cockpit graphics.

Success looks like this. An instructor arrives, types a question, waits through a
short visible checklist, and reads a calm one-column answer. Every AI claim is one
click from the exact NTSB passage. The instructor ticks up to four cases, compares
them as flight strips, and prints a clean page for class.

Goals:

- Evidence first. NTSB text dominates and AI text is visibly secondary.
- A user can always tell what NTSB said from what the AI wrote or decided.
- The app stays fully useful without AI: keyword search, filters, cases, compare,
  dashboard and print.
- Limits and outages read as normal states, not errors.

Non-goals for this release: saved collections, lesson-pack generation, a map with
tiles, user accounts beyond Google sign-in, and localisation (English only).

Anti-goals, which would be failures even if everything technically worked:

- Chat bubbles, an open-ended chat, or streaming unverified AI text.
- AI text that looks like NTSB text, or NTSB text that looks like AI output.
- Red or amber alarm colours for data, or charts that imply risk rates or rank
  manufacturers.
- Anything that looks like an official NTSB or government site.
- A generic template look: default shadcn grey, gradient heroes, emoji, stock art.

## 2. Design language: "Sectional" (Owner)

### 2.1 The colour rules

Each colour has one job. The rules are more important than the exact values.

| Colour | Job | Never used for |
| --- | --- | --- |
| Ink | NTSB data and text: narratives, probable cause, findings, coded fields | AI output |
| Chart blue | Anything you can click or set: links, case numbers, filters, buttons, selected states | Decoration |
| Magenta | Anything the AI wrote or decided: summary, "why it matched", classifications, timing it extracted, interpretation chips, the Ask AI button and counter | NTSB text, errors |
| Muted | Secondary labels, metadata, counts | Body text a user must read to understand a result |
| Hatching | Data cautions and incomplete data (the share of recent years outside the completed set) | Severity |

Magenta matches both aviation conventions. On a sectional chart it marks
features the chart adds to the terrain. On a glass cockpit it marks the course
the computer worked out. Fatal outcomes are shown in bold ink text, never in red.

Colour is never the only signal. Every AI element also carries a text label
("AI SUMMARY", "WHY IT MATCHED", "AI CLASSIFIED"). Every evidence glyph has words
next to it, and every hatched area has a "DATA CAUTION" label or a legend.

**Where AI content may appear in version one** (Proposed). Every AI element
belongs to a brief: the summary, groups, glyphs, verdict pill, "why it matched",
timing chips, attribution tags and AI compare columns. A brief is private to its
current read owner (the asker, or their new account after "Signing in
mid-brief", §5) and lives 24 hours. AI content therefore appears only on:

- the brief page
- a drawer opened from that brief
- the case page or compare page opened from that brief, while it lives

Explore, keyword compare, case pages reached any other way, and the dashboard
show NTSB data only. Those responses stay deterministic and publicly cacheable
(DESIGN §11).

Offline case-level classifications (DESIGN §3, §9) may feed a brief's evidence.
They appear outside briefs only in a later release, after review, with their
reviewed cohort stated.

### 2.2 Tokens

Day is the default theme. Night is the "Panel" theme (§2.8).

| Token | Day | Night (Panel) | Use |
| --- | --- | --- | --- |
| `paper` | `#F3EEE1` | `#1B1D20` | Page background |
| `raised` | `#FBF8F0` | `#24272B` | Cards, drawer, sheets, inputs |
| `tint` | `#E8E2CC` | `#2C3034` | Strip tabs, subtle fills |
| `ink` | `#1E2A36` | `#EDEDEA` | Main text, NTSB content |
| `muted` | `#58616B` | `#9EA3A9` | Secondary text |
| `blue` | `#1F519A` | `#93B9F7` | Interactive |
| `on-blue` | `#FFFFFF` | `#101418` | Text on filled blue |
| `magenta` | `#A0166C` | `#F07DC6` | AI |
| `on-magenta` | `#FFFFFF` | `#1B0814` | Text on filled magenta |
| `hairline` | `rgba(31,81,154,.20)` | `rgba(255,255,255,.10)` | Dividers, card borders |
| `hatch` | `rgba(30,42,54,.13)` | `rgba(237,237,234,.15)` | Caution stripes |
| `magenta-soft` | `rgba(160,22,108,.35)` | `rgba(240,125,198,.45)` | AI chip and box borders |
| `blue-wash` | `rgba(31,81,154,.12)` | `rgba(147,185,247,.16)` | Highlighted passage, facet bars, mono value chips |
| `grid` | `rgba(31,81,154,.055)` | none | Graticule lines |
| `tray` | `#1E2A36` | `#111214` | Compare tray background |
| `placard` | none | `#0E0F11` | Night label placards |
| `mark-tile` | `#1F519A` | `#2A5FAF` | The mark's folder (§2.5) |
| `mark-glyph` | `#F3EEE1` | `#EDEDEA` | The aircraft on the folder |

The mockups used muted `#5D6670`. It was darkened to `#58616B` because the
original measured 4.49:1 on `tint`, just below the 4.5:1 AA threshold for normal
text. Measured contrast for the main pairs:

| Pair | Day | Night |
| --- | --- | --- |
| ink on paper / raised | 12.6 / 13.7 | 14.4 / 12.8 |
| muted on paper / raised | 5.4 / 5.9 | 6.7 / 5.9 |
| blue on paper / raised | 6.7 / 7.3 | 8.5 / 7.5 |
| magenta on paper / raised | 6.4 / 7.0 | 6.8 / 6.0 |
| on-magenta on magenta | 7.4 | 7.8 |
| on-blue on blue | 7.8 | 9.3 |

Input placeholders use `muted`, not a lighter grey.

### 2.3 Typography

| Face | Use | Notes |
| --- | --- | --- |
| **B612** (400, 700) | All interface text, labels, buttons | Designed by Airbus and Intactile for cockpit displays; SIL OFL |
| **B612 Mono** (400, 700) | Case numbers, coded values, weather, timing chips, counts | SIL OFL |
| **Source Serif 4** (400, 600, italic 400) | NTSB text, quoted passages, probable cause, the user's question, headlines | SIL OFL; serif means "words to read" |

Proposed sizes, desktop:

| Element | Size |
| --- | --- |
| Body | 13–14px |
| Small labels | 9.5–11px, uppercase, letter-spacing 0.14–0.16em, bold |
| Quoted NTSB text | 13.5–15.5px |
| Question | 17–19px serif |
| Drawer headline | 26px serif 600 |
| Home headline | Large serif 600, letter-spacing −0.01em |

Self-host all fonts as Latin-subset WOFF2, for example from the `@fontsource`
packages, and include the OFL notices. Make no runtime requests to Google Fonts,
both for privacy and for the CSP. Preload B612 400.

### 2.4 Evidence glyphs

These represent the "mechanical evidence" dimension from DESIGN §3. They are
drawn in magenta because the classification is AI-derived, and they always
appear with their words.

| Glyph | Words |
| --- | --- |
| ● filled circle | Causal fault established |
| ◐ half-filled circle | Defect found, causal link not established |
| ○ empty circle | No fault identified |
| dashed empty circle | Insufficient evidence |

Draw them as 11px SVG or CSS circles with a 1.6px stroke, not as font glyphs.
The verdict pill on a case reads, for example, "● Causal fault established ·
AI CLASSIFIED".

### 2.5 Signature details

- **Graticule:** a 56px grid of very faint blue lines on the page background
  (day only). Cards and drawers sit on solid `raised`, so text never sits on
  grid lines.
- **Header rule:** a 2px blue bottom border with a tick scale under it, like a
  chart's scale bar. Minor ticks every 9px (3px tall), major ticks every 45px
  (6px tall), at 70% opacity.
- **Compass mark** (home only), 58px:
  - an outer ring and a dotted inner ring
  - cardinal ticks
  - an ink diamond needle
  - a magenta centre dot
- **The AirCase mark** ("Case file", Owner, 2026-10-24): a case folder carrying
  an aircraft, drawn on a 64-unit grid, transparent around the folder. The folder
  is `mark-tile` and the aircraft `mark-glyph` (§2.2), so it follows the theme and
  prints in its day colours. It has two optical sizes: below 40px the aircraft is
  heavier and a little larger, so that it still reads in a 16px browser tab; from
  40px up it is the finer drawing. It stands before the wordmark in the header,
  22px at every width and inside the home link (§3), and is the browser-tab icon, the app icons and the
  mark on the share card. It is decorative: the wordmark beside it names the
  link. Its geometry has one source, `shared/brand-mark.ts`; the home page keeps
  the compass.
- **Flight profile:** a small schematic line drawn from the NTSB event
  sequence:
  - blue solid for the flight up to the defining event
  - an ink dot with a ring at the defining event
  - an ink dashed line after it
  - an ✕ where an impact occurrence is coded
  - mono labels for phases and events

  The profile is a schematic, not altitude or time to scale; its accessible
  name says so. It appears in two sizes: about 96×28 on cards and full width
  in the drawer.
- **Mono value chips:** weather and coded values in B612 Mono on `blue-wash`,
  for example `VMC`, `10 SM`, `ALTIMETER 30.22`.
- **Timing chips:** magenta mono with a `magenta-soft` border, for example
  `5.1 FH`, `1ST FLIGHT` and `≤ 17 DAYS`. They are AI-extracted, so they are
  always magenta.
- **Status badge:** `COMPLETED` in small bold caps with a 1px ink outline.
- **Wordmark:** "AIRCASE" (the text is "AirCase"; CSS sets the capitals) in B612
  bold, 13px, letter-spacing 0.2em, chart blue. One short word, so it is the same
  at every width, and it is wider-spaced and a little larger than the two-word
  mark it replaced (owner decision of 2026-10-24, §10). It is plain text in the
  theme's `blue` by day and at night: since the owner's decision of 2026-10-24 it
  is not an engraved placard (no box, border, highlight, padding or indent). The
  mark stands before it.
- **Share card** (Owner, 2026-10-24): the image link previews show for every page
  (`og:image`, 1200×630, `web/public/social/card.png`). On chart paper with the
  graticule and the header's tick rule: the mark and the wordmark, the header's
  line "Plane crash & accident investigations" as a serif headline, under it "NTSB
  investigations since 2008: what happened, the probable cause and what
  investigators found.", the flight profile with its magenta event ring, and at
  the foot "aircase.app" and "Independent project, not an NTSB service". It is
  rendered from a template in the day tokens' colours and the app's own fonts
  (README, "Brand assets").

### 2.6 Components and controls

| Element | Style |
| --- | --- |
| Search button | Free, keyword: outline pill with a 1.5px blue border, blue bold text |
| Ask AI button | Magenta filled pill with `on-magenta` text and a counter suffix, e.g. "Ask AI · 3 free" or "Ask AI · 18 left today" |
| Filter chips | 6px radius, 1px blue border, blue text |
| AI interpretation chips | Magenta border and text with a ✎ edit mark |
| "+ Filter" chip | Dashed border |
| Case cards | `raised`, 1px hairline border, 10px radius, no shadow by day |
| Checkboxes | Blue outline square; checked is filled blue with an inset ring |
| Focus ring | 2px blue outline, 2px offset, on every interactive element |

Build these on shadcn/ui primitives, restyled through the tokens. Use Lucide icons
only for interface chrome (close, chevrons, external link, menu), with a 1.5px
stroke. The glyphs, compass, profile and header ticks are custom SVG or CSS.

Motion (Proposed):

- The drawer slides in over 200ms ease-out.
- Checklist rows tick as each stage finishes.
- Nothing else animates.
- With `prefers-reduced-motion`, everything appears instantly.

### 2.7 Data cautions

A data caution is a bordered box or chip with diagonal hatching on `raised`, a
"DATA CAUTION" label, and one plain sentence. Example: "The record header says
8 February and a minor injury; the factual narrative says 9 February and serious
injuries. Both are shown as published." Cautions never use red.

Version one shows deterministic cautions only (Proposed). Examples:

- missing or conflicting completion status
- conflicting coded fields
- unvalidated coordinates
- ambiguous aircraft attribution in a multi-aircraft event
- a coded injury level that disagrees with the injury counts

The header-versus-narrative example above was found by reading the report. If
the AI ever flags a narrative inconsistency, that caution must carry a magenta
"AI" label like every other AI output.

### 2.8 Night mode: "Panel" (Owner)

Night is matte charcoal, like an instrument panel. It has no graticule. The
colour rules in §2.1 stay the same; only the tokens change.

- **Placards:** small labels (eyebrows such as "YOUR QUESTION" and section
  heads such as "THE FLIGHT") become engraved placards:
  - near-white text on `placard`
  - a 1px `rgba(255,255,255,.16)` border and a 2px radius
  - inset top highlight `rgba(255,255,255,.06)`

  AI eyebrows keep magenta text inside the placard. The wordmark is not a
  placard: it stays plain text, in the night `blue` (owner decision of
  2026-10-24; it was a placard until then).
- **The mark** at night: a brighter folder (`#2A5FAF`) carrying a near-white
  aircraft (`#EDEDEA`).
- **Bezels:** cards and sheets get `inset 0 1px 0 rgba(255,255,255,.05), 0 1px
  0 rgba(0,0,0,.6)`.
- **Header:** the bottom border is `rgba(255,255,255,.22)` and the tick scale is
  near-white at 35% opacity.
- Glyphs, hatching, serif and mono work as they do by day.
- Placards appear only at night (Proposed).

Switching themes (Proposed):

- A "DAY | NIGHT" segmented switch sits in the header, or in the menu on a
  phone.
- Until the user touches it, the theme follows `prefers-color-scheme`.
- The choice is stored in `localStorage` on that device only. No account is
  needed, and reads and writes are wrapped in try/catch.
- Set the `data-theme` attribute before first paint with a small inline script
  (CSP-hashed) to avoid a flash of the wrong theme.
- Charts, the dot map and the Turnstile widget (`theme` option) follow the
  theme.
- Print always uses day colours on white (§7).

## 3. Global frame

**Header** (all pages):

- the mark and the wordmark, linking home; the link's name is "AirCase" alone,
  the mark being decorative (§2.5). The link's box, and so its focus ring, holds
  both at every width.
- the line **"Plane crash & accident investigations"** (Owner, 2026-10-24), so a
  stranger sees at once what the site shows. It is plain text outside the link,
  in the header's muted meta style (11.5px, `muted`):
  - from 1024px, beside the wordmark after a hairline;
  - below 1024px, on tablets and phones, under the wordmark, starting where the
    wordmark does: a second line under the rest of the header (review ruling of
    2026-10-24 for tablets). There is no room for it beside the navigation, the
    AI counter, the Day/Night switch and Sign in, so it runs under them, 3px
    below the active item's underline on a tablet (§6 for phones).

  It is never cut short and never wraps the navigation. The desktop and phone
  headers keep their heights; on a tablet the header grows by the line (about
  19px; more where touch targets make the first line taller). It does not
  print (§7).
- Explore and Dashboard navigation, with the active item underlined in blue
- the AI counter (§5)
- the Day/Night switch
- Sign in, or an account menu when signed in

**Footer** (all pages): "Not an NTSB service · Data: NTSB, snapshot {date} ·
Privacy · About", and under it a quieter line, "Built by Mariusz Kotas ·
mkotas.cz", in the same style, with the website as a link to https://mkotas.cz
that opens in a new tab like the links to NTSB reports (Owner, 2026-10-24; it is
public on purpose, not personal data to remove; the e-mail address is on the
About page, §4.8). It shows on
every page, on a phone, at night and in print (the plain fallback page of a
failed app frame has the line too), and uses the footer's own tokens (muted
text, the blue link), so contrast is that of those pairs (§2.2). The link is
reachable by keyboard like Privacy and About. The snapshot date comes from the
ingestion run. If the snapshot is older than expected, the footer shows its real
age (DESIGN §4). As built (Task 22, Proposed): more than 45 days after a
snapshot, against DESIGN §4's monthly full snapshots, the date is followed by
"(46 days old)", and from two whole months by "(2 months old)".

**Routes and URL state** (Proposed). Every view a user might share or refresh
lives in the URL:

| Route | View |
| --- | --- |
| `/` | Home |
| `/explore?q=…&phase=…&inj=…` | Keyword search; all filters in the query string |
| `/explore?…&case=DFW08TA066` | Drawer open over the results |
| `/briefs/:id` | An AI result, showing the latest step. Visible only to the brief's current read owner and only while the brief lives (24 hours, DESIGN §2). Otherwise the expired state in §5 is shown. |
| `/briefs/:id?step=n` | An earlier answer in the same brief (steps 1–4). A small "Answer 1 · 2 · 3" switcher sits under the question. |
| `/briefs/:id?step=n&case=DFW08TA066` | Drawer open over a brief, with that step's AI context |
| `/cases/:ntsbNo` | Full case page, NTSB data only |
| `/cases/:ntsbNo?brief=:id&step=n` | Full case page plus that brief step's AI context |
| `/compare?cases=A,B,C,D` | Compare, up to four, NTSB columns only |
| `/compare?cases=A,B,C,D&brief=:id&step=n` | Compare plus that brief step's AI columns |
| `/dashboard?…cohort…` | Dashboard |
| `/account`, `/privacy`, `/about` | Account, privacy and about pages |

A brief ID in a shared link reveals nothing to another user.

**AI context is a separate, private read** (Proposed). Case and compare data come
from public, cacheable endpoints that never contain AI output. AI context comes
from a separate endpoint keyed by brief, step and case, for example
`GET /api/briefs/:id/steps/:n/cases/:ntsbNo`. That endpoint:

- authorizes the brief's current owner on every read
- answers with `Cache-Control: private, no-store`
- never merges its content into the public response

If the brief reference is missing, expired or not the viewer's, the page renders
NTSB data only, with a muted note: "The AI notes for this case have expired or
aren't yours." The step in the URL settles which AI reading applies when the same
case appears in two briefs.

**Keyboard:** Enter in the search box runs **Search**, which is free. Ask AI
needs an explicit click or Ctrl/Cmd+Enter, so nobody spends an AI search by
accident (Proposed).

## 4. Screens

### 4.1 Home: "Clear sky" (Owner)

A centred, nearly empty page on the graticule:

- the compass mark
- the headline **"Learn from the record."**
- a large question box with the serif italic placeholder "What happened, and
  what did investigators establish?"
- two buttons, **Search** and **Ask AI · 3 free**
- three example chips: "Carb icing on climb-out", "Stall/spin in the pattern"
  and "Power loss after maintenance"
- one coverage line at the bottom: "24,291 completed US NTSB investigations ·
  2008 → 2026 · snapshot 01 OCT 2026 · not an NTSB service"

The coverage line is computed from the data.

Example chips only fill the box; they never run a search (Proposed). There is no
hero art, featured case or marketing copy.

### 4.2 Keyword search with facets (Owner: "Facets with counts")

Two columns on desktop: a 236px facet column and the results column.

**Facets:**

- Every value shows its count as a thin `blue-wash` bar behind the label, with
  the number right-aligned in mono, so the spread itself teaches something. For
  example, carburetor-icing cases are overwhelmingly day VMC.
- A selected value has a filled blue bar and `on-blue` bold text.
- Counts for other values update as filters change. Within one facet the counts
  ignore that facet's own selection, so alternatives stay visible.
- Unknown and not-reported values are shown in muted text and never hidden.
- The aircraft facets (phase, aircraft, engine, operation, purpose) count an
  event once per value any of its aircraft has, so they can add up to more than
  the total (G0 #14). As built (Task 22, Proposed wording): under Phase, "3
  investigations here involved more than one aircraft, so phase counts can add up
  to more than 21."; once above the aircraft facets in "More filters", "… so
  aircraft, engine, operation and purpose counts can add up to more than 21."

Facet order:

1. Mentioned in: anywhere in the report, or probable cause
2. Phase
3. Highest injury
4. Conditions (VMC/IMC/unknown)
5. Year: a small histogram where the share of each year outside the
   completed set is hatched
6. "More filters": aircraft, engine, operation/FAR part, purpose, light,
   location, date. The set follows DESIGN §2.

**Results column:**

- The search box with Search and Ask AI.
- A count line, e.g. "**58** completed investigations · Newest first ▾".
- Result rows, each with three lines:
  - case number (blue mono bold), date, aircraft (bold), place, and a Compare
    checkbox
  - a mono line: phase · defining event · conditions and light · highest injury
    (fatal in bold ink)
  - probable cause in serif, with matched terms highlighted in `blue-wash` with
    a blue underline
- A quiet magenta-bordered nudge at the end: "Want these grouped and explained?
  Ask the AI with these filters." It has its own Ask AI button.

Keyword results are complete matches with a real total. They are not "examples".

**Matching** (Proposed):

- BM25 `match` over allowlisted text fields with an English analyzer and
  stemming.
- All words must match (`operator: and`). A quoted phrase must match as a phrase.
- A small curated synonym list covers common aviation shorthand, for example
  "carb" for carburetor, "wx" for weather and "CFI" for flight instructor. The
  list is versioned with the index.
- The total in the count line is the exact hit count for these rules.
- Each home example chip must return results. A test enforces this.

**Snippets:** the third line of a row shows the probable cause when the terms
match there. Otherwise it shows the best matching snippet with its section label
in small caps ("ANALYSIS", "FACTUAL").

**Completion** (Proposed). Records outside the completed set are not all
unfinished investigations. In the 2026-10-16 snapshot, the 1,116 US records
outside the set had these statuses:

| Raw status | Records |
| --- | --- |
| `P` | 1,040 |
| `F` | 18 |
| Blank | 56 |
| `B` with no probable-cause text | 2 |

Completion status, probable-cause availability and AI eligibility are separate
facts. The status badge never claims more than the data supports:

| Status class | Badge | Meaning |
| --- | --- | --- |
| Completed | `COMPLETED` | A verified completed status |
| In progress | `IN PROGRESS` | A status the milestone-1 mapping verification (DESIGN §4) shows to be unfinished |
| Status unknown | `STATUS UNKNOWN` | Blank or unmapped |

Until that verification is done, the last two collapse into one class, "Other
status", with the badge `OTHER STATUS`.

- The default cohort, and the only one AI answers use, is completed records
  with probable-cause text: 24,291 in the snapshot.
- A completed record without that text (2 in the snapshot) keeps its
  `COMPLETED` badge. It adds a muted line, "Probable-cause text unavailable",
  and is excluded from AI answers.
- "No probable cause on record" appears wherever the field is actually empty,
  whatever the status.
- A Completion facet sits first, with "Completed, with probable cause" selected
  by default.
- "Other records" means everything outside that default cohort (1,116 in the
  snapshot).
- Every badge other than `COMPLETED` has a muted line giving the raw code, for
  example "NTSB status: P". Codes are never interpreted beyond the verified
  mapping (DATA_REVIEW warns against guessing).
- Records outside the default cohort appear in Explore, on case pages and in
  compare.

### 4.3 AI results: "Briefing sheet" (Owner)

One calm reading column, about 640px, centred. From top to bottom:

1. **YOUR QUESTION**, then the question in serif.
2. **Chips:**
   - magenta, editable interpretation chips, e.g. "“Shortly” = within 30 days
     or 10 flight hours ✎"
   - blue chips for the cohort and filters ("Completed investigations",
     "United States · 2008–2026")
   - "+ Filter"

   Editing an interpretation chip is a refinement and is metered (DESIGN §2).
3. **AI SUMMARY · CHECK THE CITED PASSAGES:** serif text with a 3px magenta
   left rule. Case numbers in the text are blue mono citations. Clicking one
   opens the drawer scrolled to the cited passage. A citation of an unconfirmed
   case (see the case card) carries an UNCONFIRMED tag.
4. **A results label:** for example "6 examples found · not every matching
   investigation". This is required by DESIGN §5.
5. **Evidence groups:** a glyph, the group name in bold, the count in muted
   text, and a hairline to the right. Order: causal fault established; defect
   found, causal link not established; no fault identified; insufficient
   evidence. An empty group still shows, with "none", so absence is explicit
   (Proposed).
6. **Case cards**, each containing:
   - Header row: case number, aircraft, place · date, and a Compare checkbox.
   - **WHY IT MATCHED** in magenta: one line from the AI, plus timing chips,
     one per time relation the passages state (flight hours, days, which flight
     after the maintenance, or "NOT QUANTIFIED" for words only).
   - **UNCONFIRMED** label when the passages do not settle one of the reader's
     criteria (no time since maintenance stated, or only an approximate one such
     as "about eight hours"). Such a case is never presented as a confirmed
     match; the drawer's CRITERIA line says what the passages do not establish.
   - The quoted NTSB passage: serif, 2px ink-alpha left rule, labelled "NTSB ·
     ANALYSIS" (or the section name).
   - A footer row:
     - the mini flight profile, with "PHASE · DEFINING EVENT" in mono
     - a data caution chip, if any
     - a source link: "NTSB report ↗" when resolved, otherwise "Direct report
       link unavailable · Search NTSB ↗", labelled as a search (DESIGN §4)
7. **Gaps line**, muted, with blue actions. Example: "Just outside your window:
   NYC08LA106, fuel pump installed 12 flight hours and about two months
   earlier. *Include it* · Not placed: cases with no maintenance date in the
   report. *Show them*"
8. **REFINE:** a box with the placeholder "e.g. only aeroplanes, not
   helicopters" and a magenta "Refine · 2 left" button. The suffix is the same
   AI counter as Ask AI. After the third refinement the box is replaced by "This
   brief has used its three refinements. Start a new search to keep going."
   (Proposed)
9. **Compare tray:** a dark `tray` bar fixed to the bottom of the viewport. It
   shows the ticked case numbers, "2 of 4" and "Compare →". Ticking a fifth case
   shows "Compare holds four cases. Remove one first." (Proposed)

**No supported match**: when the AI finds that none of the retrieved cases'
passages supports the question as asked, the sheet shows the retrieved cases as
plain cards and its gap notes, under server copy that speaks about the
retrieved cases only ("None of the cases this search retrieved has passages that
support your question as asked."), never that no such investigation exists. It
counts as a search, because the AI analysis ran.

**Questions that aren't about mechanical cause** (Proposed): group by
mechanical evidence only when the scope step says the question concerns a
mechanical or maintenance cause. Otherwise show one "Examples found" list in
relevance order. Each card keeps "why it matched", and glyphs appear only on
cases that were classified.

**What costs an AI search on a brief** (Proposed). Nothing is charged silently.
Any control that would run the AI shows "· uses 1" on the button before the
click.

| Action | What happens | Cost |
| --- | --- | --- |
| Refine (free text) | A new step in the same brief | 1 search |
| Editing an interpretation chip | A small structured editor (calendar days, flight hours, first flight only), then a new step | 1 search |
| Removing a filter chip or using "+ Filter" on a brief | Offers two buttons: "Re-run AI · uses 1" and "Show keyword results" (free; opens Explore with the brief's filters) | 1 search or free |
| Gaps line: "Include it" / "Show them" | Opens Explore with the relevant case or filter applied | Free |
| Step switcher, drawer, compare, print | Reads what is already there | Free |

Each refinement adds a step at the same `/briefs/:id`. The newest step is shown,
and earlier steps stay readable through the step switcher until the brief
expires.

The refinement request is a bounded Zod discriminated union, validated
server-side (DESIGN §2):

| Kind | Payload |
| --- | --- |
| `text` | Up to the question length limit |
| `interpretation` | An allowlisted field (`timing_window`, `first_flight_only`…) with a typed, range-checked value |
| `filters` | The same validated filter object Explore uses |

Every variant goes through the full scope check again and counts as one
refinement.

**Scope outcomes** (Proposed). None of these is chat, and none uses a free
search. They still count toward abuse limits.

| Scope result | What the user sees |
| --- | --- |
| `needs_clarification` | The planner returns only an allowlisted ambiguity type plus validated values, never free text. Examples: `timing_window` with candidate windows, `aircraft_category` with facet values, `phase` with phase codes. The server renders two or three readings from fixed templates ("Within 30 days or 10 flight hours", "Helicopters only"…) as magenta interpretation chips labelled "AI SUGGESTED READINGS", under the static line "Which did you mean? Pick one to ask the AI." They belong to the private brief like any AI output. Picking one runs a normal AI search (1 search). There is no free-text reply. |
| `corpus_statistics` | Static: "Counting questions are answered from the data directly, not by the AI." A link opens the dashboard or Explore with the planner's validated filters. |
| `case_comparison` with named case numbers | Opens `/compare` with the validated numbers. Unknown numbers are listed as "not found". |
| `out_of_scope` | Static: "This tool only searches NTSB aviation investigations." / "Try a question about what happened in past accidents or incidents." / [Search by keyword instead] |
| `operational_advice` | The operational state in §5 |

**Multi-aircraft events** (Proposed). The unit you tick, open and compare is
the event (`ntsb_no`).

- **Row or card:** shows "2 aircraft" with both make/models.
- **Headline template:** names both aircraft, for example "Midair collision
  between a Cessna 172 and a Piper PA-28 near …".
- **Brief evidence:** cards and strips name the aircraft the evidence
  is attributed to (suffix and make/model). When attribution is ambiguous,
  they show the caution "Applies to the event; aircraft not stated" and do not
  assign a glyph (DESIGN §5).
- **Compare strip:** gets one sub-row per aircraft for FLIGHT, CONDITIONS and
  SINCE MAINT.
- **Drawer and case page:** the flight profile has an aircraft switcher
  (A/B).

**Who is speaking in a passage** (Proposed). The section label ("NTSB ·
ANALYSIS") is deterministic and always shown. When the brief's attribution says
the quoted words are a pilot's or witness's account, rather than the
investigators' examination or analysis, the card adds a magenta tag such as
"PILOT'S ACCOUNT · AI READING". Seed case DEN08LA103 depends on this
distinction.

**Validation failed** (DESIGN §5): a hatched box labelled **SUMMARY WITHHELD**
reads "The AI's summary didn't pass the citation check, so it isn't shown. Below
are the 6 cases it found, with their NTSB text. You can still open, compare and
print them." The cases follow as plain cards with no AI lines. This counts as a
search.

**What the evidence check removed** (Task 16e, Proposed: every string below awaits
owner review). The server's display projection (DESIGN §3, claim-level display) decides
what is shown; the page renders its states and never drops a case it counts. All of it
is server data or fixed templates, never model text.

| Where | Copy |
| --- | --- |
| Checklist row "Verify every quote", result | "COMPLETED · 2 STATEMENTS REMOVED" ("1 STATEMENT", "0 STATEMENTS"), "COMPLETED" for a result stored before the count existed, "NOTHING TO CHECK" for an abstention with nothing of its own to check; spoken "Evidence check completed: 2 statements removed." |
| Under the summary | "Evidence check completed · 2 statements removed" (replaces the universal "PARTLY CHECKED") |
| A removed run of summary sentences | "[one statement not shown: the check could not confirm it]" (Task 16d) |
| Cases kept without a confirmed classification (mechanical grouping) | A section "Not classified" after the groups: "The evidence check could not confirm a classification for these cases." |
| The same for examples | "Not confirmed": "The evidence check could not confirm an AI reading of these cases." |
| Card without its AI reading | Tag "AI reading not shown": "The check could not confirm this case’s AI reading against the cited passages. Its NTSB text is below." |
| Card with fields removed | Tag "Not verified": "The check could not confirm the timing and a quote against the cited passages, so they are not shown." (the fields named from: why it matched, the classification, the maintenance relation, the symptom, the timing, a quote, your criteria) |
| Card with quotes the excerpt rule left out | "One quote left out: it needs the report’s surrounding text to keep its meaning." / "2 quotes left out: they need the report’s surrounding text to keep their meaning." |
| Drawer, case without its reading | Line READING: "AI reading not shown: the check could not confirm it against the cited passages" |
| Drawer, quotes left out | Line QUOTES: "One quote left out: it needs the report’s surrounding text to keep its meaning" |
| Drawer, a removed field (Task 16d) | "Not verified: the check could not confirm this against the cited passages" |
| Compare strip | "AI reading not shown: the check could not confirm it"; "Timing not verified by the check"; "Classification not verified by the check" |

Print keeps every marker, note and unclassified case (nothing above is
`data-print="hide"`).

### 4.4 While the AI works: "Checklist" (Owner)

The question and chips stay on top. Below them is a challenge-and-response
checklist card like a cockpit checklist:

- **Header bar:** ink background, paper text, the title "ANSWER CHECKLIST", and
  an elapsed timer on the right.
- **Rows:** B612 Mono with dotted leaders to the result. Each fills in its real
  result as the stage completes, with a magenta ✓:

  | Row | Result |
  | --- | --- |
  | Question | IN SCOPE |
  | Search 24,291 investigations | 6 CASES · 12 PASSAGES |
  | Write answer | IN PROGRESS |
  | Verify every quote | — |

- **The current row** has a faint magenta wash and magenta result text. Rows not
  yet reached are muted.
- **Note under the card:** "Nothing is shown until each quote matches the report
  text word for word. Usually about a minute; up to two." It ends with a
  **Cancel** link. (Task 22, Proposed: the owner's "Up to a minute." replaced as the
  gate asked, from the measured stages, scope 2–4 s, retrieve 1–2 s, compose
  19–23 s and check 20–38 s at p50–p95, within the 100 s pipeline deadline.)
- **While reads of the step fail** (Task 22, Proposed): a muted line under the
  note, "Still checking… connection trouble.", from the first read that fails or
  gets no answer within 15 seconds, until a read gets through.

The four rows map to the pipeline's scope, retrieve, compose and validate stages.
Admission (Turnstile and quota) happens before the checklist appears, and
settlement is invisible. The server sends only stage status and counts, never
partial answer text. Whether to use polling or SSE is a Builder decision.

Cancel still counts as a search (Owner-approved).

### 4.5 Case drawer: "Story order" (Owner)

The drawer opens from the right over the results. It is about 58% of the viewport
width, at least 470px and at most about 760px, with a 2px blue left edge and a
soft shadow. The results behind it stay in place under a 16% ink shade. It is a
single column with no side-by-side panels, because the owner specifically
rejected column layouts in the drawer.

**Toolbar:**

- ✕
- "‹ 1 of 3 ›", which steps through the current result list
- "+ Compare"
- "Open full page ↗" as an outline pill

**Body:**

1. **Identity:** the case number in blue mono, the status badge, and Accident
   or Incident.
2. **Headline** in 26px serif 600, built from a fixed template over coded fields,
   never by the AI (Proposed). The pattern is "{make model}{category noun if
   not an airplane}, {defining event} {phase phrase} near {city, state}". The
   mockup's "Hughes OH-6 helicopter, total power loss in a hover near Valentine,
   Texas" was hand-written; generated wording will be plainer. The Builder
   writes the phrase tables from the NTSB code dictionary.
3. **Meta line:** date · FAR part and purpose · damage · highest injury.
4. **Verdict pill:** glyph, words, and "AI CLASSIFIED". It appears only when the
   drawer is opened from the viewer's own live brief and that brief classified
   the case (§2.1).
5. **Data caution(s).**
6. **THE FLIGHT** (tag "NTSB EVENT SEQUENCE"): the full-width flight profile,
   then a weather line of mono chips (VMC · DAYLIGHT · CLEAR · 10 SM ·
   ALTIMETER 30.22). A muted note says where the observation came from, e.g.
   "Observed at Marfa (MRF), 40 nm from the site, 11:15 local. No METAR text on
   record."
7. **WHAT INVESTIGATORS ESTABLISHED** (tag "NTSB"): the probable cause in 15.5px
   serif, then the findings list. Findings with `cm_inPC = T` carry a small
   `IN PROBABLE CAUSE` tag. That field merges causal and contributing findings
   (DATA_REVIEW), so the interface never labels a finding "cause" versus
   "contributing" unless a verified source states it. The mockup's `CAUSE` tags
   are superseded.
8. **WHY IT'S IN YOUR RESULTS** (tag "AI READING · CHECK THE PASSAGE"): a
   magenta-bordered box of labelled lines (TIMING, MAINTENANCE…), each with a
   "passage ↓" jump. This section appears only when the drawer is opened from a
   brief the viewer currently owns.
9. **CITED PASSAGE** (tag "NTSB · ANALYSIS"): the surrounding paragraph in muted
   serif with the cited span highlighted in ink on `blue-wash` with a blue
   underline. Below it is "Read the full analysis".
10. **Provenance footer:** source section, captured snapshot or revision date,
    and the report link or labelled search fallback.

**Full case page** (`/cases/:ntsbNo`, Proposed). It uses the same story order in
a 680px column and adds:

- the full narrative sections (factual, analysis, probable cause, findings) in
  that order
- all aircraft for multi-aircraft events, with aircraft-scoped text labelled
  per aircraft (DESIGN §4)
- "+ Compare" and "Print for class"

It has no AI content unless opened from the user's own live brief; in that case
the "why it's in your results" section is included.

Its browser tab reads "{headline} ({event year}) · NTSB {ntsbNo} · AirCase", for
example "Piper PA-28-235, total loss of engine power on final near Montevideo,
Minnesota (2026) · NTSB CEN26LA211 · AirCase", and "NTSB {ntsbNo} · AirCase" while
the case loads or when no case has that number (Owner request, 2026-10-24, SEO; the
year is left out when no event date is recorded).

### 4.6 Compare: "Flight strips" (Owner)

Compare is a page, not a modal. The top of the page has:

- "← Back to results"
- the title "Comparing 4 cases"
- tools: Sort ▾, Print for class, Copy link
- "From your search “…”" when the cases came from a brief

Each case is a strip like an ATC flight progress strip:

- **Left tab** (30px, `tint`) holding the evidence glyph.
- **One row of columns:**

  | Column | Content |
  | --- | --- |
  | CASE | ✕ remove, case number, aircraft, registration/category |
  | WHEN · WHERE | Date (with caution chip if any), place, part · purpose |
  | FLIGHT | Mini profile and "PHASE · EVENT" |
  | CONDITIONS | Mono, e.g. VMC · DAY / BKN 3100 / 10 SM |
  | SINCE MAINT. | Magenta heading: big mono timing value plus a magenta qualifier |
  | ESTABLISHED | Magenta heading: bold classification plus one line |

- **Second row:** PROBABLE CAUSE in serif, with the source link at the right.

Strips stack so the same field lines up down the page.

**Below the strips:**

- Values identical across all cases collapse into one line, e.g. "Same in all
  four: VMC · daylight · substantial damage · no fatalities · completed
  investigations".
- A key line explains the strip tab and the sort.

**Without AI** (Proposed): the AI columns appear only for cases that the
current brief classified or extracted. Compare opened from keyword search shows
only NTSB columns and still works. This is the deterministic comparison in
DESIGN §7.

**Sort options:**

- As added (default)
- Date
- Flight hours since maintenance, available only when timing exists. Cases
  without hours go last; days are never converted into hours.

### 4.7 Dashboard: "Questions" (Owner)

Title: "The record, in questions". Under it is a row of cohort chips that always
shows the denominator:

- "Completed investigations · 24,291" (on)
- "+ Include 1,116 other records". The mockup said "still open". The accurate
  label is "other records" (or "in progress" and "status unknown" once the
  mapping is verified), because the 1,116 mix several raw status codes and
  missing values (§4.2).
- "United States"
- "2008 – 2026"
- "All aircraft ▾"

Each panel is titled with a question in serif, answered by one factual sentence
generated from a fixed template with computed numbers, never by the AI, followed
by its chart:

1. **How complete is the recent record?** (full width) This comes first. Stacked
   year bars show completed and other records per year. Example
   sentence: "2025 has 758 completed of 1,176 events, and 2026 only 270 of 870,
   so recent years look smaller than they will be." The legend reads "Completed"
   and "Other records (not a verified completed status)" (Task 22: never "in
   progress" or "status unknown" while the mapping is unverified, decision 20).
2. **When in the flight did it happen?** Phase bars, with a sentence that
   includes "That counts investigations, not risk per landing." Phase is each
   aircraft's defining-event phase, so the panel states the overlap (G0 #14; Task
   22, Proposed wording): "3 investigations involved more than one aircraft, so
   phase counts can add up to more than 21."
3. **How serious were the outcomes?** Highest-injury bars.
4. **What was the weather?** VMC, IMC and unknown.
5. **What was flying?** Aircraft category, with the same statement ending "so
   aircraft counts can add up to more than 21."
6. **Where?** A static dot map of coordinates for the lower 48, with Alaska and
   Hawaii as insets later. A sentence states how many cases lack coordinates.
   There are no tiles (DESIGN §10).
7. **What can this data tell you?** (full width coverage panel):
   - probable cause text available (count, percentage)
   - raw METAR text (count, percentage)
   - "How many flights or hours were flown (needed for any risk rate): not in
     this data"
   - "AI evidence classification: not used in these charts", in magenta

The bars reuse the facet style: a thin bar, then the label, count and percentage.
Unknown or not-reported values are muted and shown. Every bar is a button that
opens Explore with that cohort and value applied.

AI-derived charts stay out until a reviewed share of cases is processed. They
then state the processed cohort (DESIGN §5).

### 4.8 Sign-in, account and privacy (Proposed)

- **Sign-in dialog:** the title "Sign in to AirCase", a "Continue with
  Google" button, and then what is kept:
  - "We keep your Google account ID, email and name, and how many AI searches
    you've used."
  - "Questions and answers are held for up to 24 hours to deliver them, then
    deleted."
  - "Delete your account any time from Account."

  It ends with a link to the privacy notice.
- **First sign-in:** "Welcome aboard. You have 5 AI searches a day for your
  first three days, then 20." Then a Continue button. The training-email
  checkbox the owner saw in the mockup is **deferred** (Owner) until an email
  provider exists, together with email/password accounts. When it returns, it
  is a separate, unticked opt-in, as DESIGN §7 requires.
- **Account page:**
  - name and email
  - AI searches left, e.g. "18 of 20 left today · 109 of 150 left this month"
  - Sign out
  - **Delete account**, which explains what goes immediately, that backups
    expire within 30 days, and the minimal anti-abuse and financial records
    that remain (DESIGN §7). As built (Task 20 review, Proposed): backups never
    hold accounts or AI searches, so the line says that instead; and deleting
    needs a recent Google sign-in. Within 5 minutes of signing in the page asks
    once more ("Delete your account now? This can't be undone."); otherwise it
    first says "To delete your account, first confirm with Google that it's
    you." with [Continue with Google], comes back to the account page and then
    asks once more. Coming back without a confirmation says nothing was
    deleted.
- **Privacy page:** plain-language processing notice, linked from the footer
  and the sign-in dialog. The owner approved the final text on 24 October 2026
  (Owner); it was checked statement by statement against the code and is the
  authority on what the site keeps (who is responsible, the site's four cookies,
  what the server, accounts and AI searches keep, the processors, retention,
  legal bases and rights). It names Cloudflare Turnstile (Task 22 review W-14):
  asking the AI loads Cloudflare's script and frame from challenges.cloudflare.com,
  only when an AI request needs a check, and Cloudflare may set its own cookies for it.
  Any change to what the site keeps changes this text and its date in the same commit.
- **About page** (`/about`, a reading column like Privacy): "About AirCase" says
  what AirCase is (an aviation casebook for flight instructors and safety
  analysts), what it does today (keyword search with filters, a page for each case,
  Compare for up to four cases, the dashboard; AI features are not available yet),
  where the data comes from (the NTSB database, with the snapshot and coverage), what
  it is not (not an NTSB service, no operational advice), and, under "Built by", that
  it is built by Mariusz Kotas, with his website mkotas.cz (a link, in a new tab) and
  the contact address m@mkotas.cz as a `mailto:` link: "AirCase is built by Mariusz
  Kotas. Website: mkotas.cz. Contact: m@mkotas.cz." (Owner, 2026-10-24). The browser
  tab reads "About · AirCase".

## 5. States and copy (Owner-approved)

**AI counter in the header:**

| State | Text |
| --- | --- |
| Anonymous, fresh | "AI searches left: **3 of 3**" (number in magenta) |
| Anonymous, one left | "AI searches left: **1 of 3**" |
| Trial used | Blue outline pill "Sign in to keep asking" |
| Signed in | "AI left today: **18 of 20**" (always the number left) |
| Free searches paused, sign-in still open (Proposed) | Blue outline pill "Sign in to ask the AI" |
| Trial used, sign-in not offered (Task 22, Proposed) | Muted "Free AI searches used" (also while the configuration that says whether sign-in is offered cannot be read: it is read again until it can; nothing is said while its first read is on its way) |
| Free searches paused, sign-in not offered (Task 22, Proposed) | Muted "Free AI searches paused for today"; in the login-required mode "AI temporarily unavailable" (the same while the configuration cannot be read) |
| Signed-in cap reached (Proposed) | Muted "AI back tomorrow" (daily) or "AI back on 1 Nov" (monthly) |
| Paused for everyone | Muted "AI back tomorrow" for the daily budget, "AI back on 1 Nov" for the monthly budget, or "AI temporarily unavailable" when the recovery time is unknown |

The counter and the Ask AI/Refine labels show availability before anyone clicks.
They read a coarse state from a public status endpoint, for example
`GET /api/ai/status`. The endpoint returns:

- `state`: `available`, `signed_in_only` or `paused`
- for `paused`, a coarse `reason`: `daily_budget`, `monthly_budget`,
  `maintenance` (kill switch) or `dependency`
- an optional `retryAt`, sent only when the recovery time is actually known
  (budget resets)
- the principal's own remaining counts

It reveals no budget amounts. Labels follow it:

| State | Ask AI label |
| --- | --- |
| `available` | "Ask AI · 3 free" |
| `signed_in_only`, anonymous visitor | "Ask AI · sign in" |
| `signed_in_only`, sign-in not offered (Task 22, Proposed) | Button disabled, with the counter's words ("Free AI searches used"…); never "sign in" |
| `paused` with `retryAt` | Button disabled, with "AI back tomorrow" or "AI back on {date}" |
| `paused` without `retryAt` | Button disabled, with "AI temporarily unavailable" |

When the status cannot be read, the button is disabled with "AI temporarily
unavailable" too, and the page reads the status again every 15 seconds and when
the tab gets focus until it can (Task 22).

**Messages:**

| Moment | Copy and behaviour |
| --- | --- |
| First Ask AI, anonymous | Panel titled "Quick check before your first AI search", with "Up to three free AI searches, subject to daily availability. Search, cases and comparisons never need this." The Turnstile widget sits inside it. The explanation is shown once per trial identity. |
| Later anonymous AI requests (Proposed) | Every anonymous AI request, including refinements and retries, needs a fresh single-use Turnstile token (DESIGN §8: tokens expire after five minutes). The page keeps an invisible or managed widget and gets a new token at click time. The button shows "Checking…" briefly, then "Starting…" while the request is on its way (Task 22, Proposed: the server answers once the scope stage is done, a few seconds). Only if Cloudflare demands interaction does the panel reappear, titled "Quick check before this AI search". The server validates every token; an expired or reused token fails before any spend. |
| Trial used up | "That was your third free AI search." / "Sign in with Google to keep asking. New accounts start with 5 AI searches a day, rising to 20 after three days." / [Continue with Google] / "Search, case pages, compare and the dashboard stay open without an account." Shown **only while signed-in capacity remains**. Where sign-in is not offered (Task 22, Proposed): "That was your third free AI search." / "Everything else works: keyword search, every case, comparisons and printing." / [Search by keyword instead]. |
| AI paused for today | Ink-edged box: "AI search is done for today." / "This beta runs on a small daily AI budget, and today's is used up. It resets at 00:00 UTC." / "Everything else works: keyword search, every case, comparisons and printing." / [Search by keyword instead]. Shown to everyone, signed in or not. This is a normal state. Proposed variants: for the monthly budget, "AI search is done for this month." / "It returns on {date}."; for maintenance or a provider outage, "AI search is temporarily unavailable." with no time promised. |
| Operational question | Blue-edged box: "This tool studies past investigations." / "It can't help with a flight in progress or a maintenance decision. In flight, contact ATC. For airworthiness, use your aircraft's approved data and a certificated mechanic." / "You can still look for past cases like yours:" plus two blue suggestion chips. Static text; no AI-written advice. |
| Failure | "The AI search didn't finish." / "Something went wrong before an answer was ready." / [Try again] [Search by keyword instead]. Add "This didn't use one of your searches." if nothing was spent, or "This counted as a search, because the AI work was already under way." if it was. Try again sends the same request (Task 22, Proposed): a failed refinement is refined again with its change; where that is impossible there is no Try again but "This brief has used its three refinements. Start a new search to keep going." or "The changed reading can't be tried again from here. Start a new search to keep going." with [New search]. A Try again that fails too adds, in the same card, "Trying again didn't finish either." and whether it counted. |
| No results | "No completed investigations match all of this." Below it, the query and filters in words, and suggestion chips with real counts for removing one filter at a time, e.g. "without Fatal · 1 case", "without Phase: Taxi · 102 cases", "include other records". |
| Free searches paused, visitor's trial untouched (Proposed) | "Free AI searches are used up for today." / "Signed-in AI search is still open today. Sign in with Google to ask." / [Continue with Google] / "Free searches return tomorrow; keyword search and every case work now." Also used in the login-required emergency mode (DESIGN §7), with the last sentence dropped. Where sign-in is not offered (Task 22, Proposed): "Free AI searches are used up for today." / "Free searches return tomorrow; keyword search and every case work now."; in the login-required mode, the "AI search is temporarily unavailable." box. |
| Signed-in daily cap (Proposed) | "You've used today's 20 AI searches." (5 for new accounts) / "They reset at 00:00 UTC. Keyword search, cases and compare work as usual." |
| Signed-in monthly cap (Proposed) | "You've used this month's 150 AI searches." / "They reset on 1 {month}. Keyword search, cases and compare work as usual." |
| Extra check, signed in (Proposed) | Same panel as the first anonymous check, titled "Quick check before this AI search". |
| Brief expired (Proposed) | "This AI search has expired. We delete questions and answers after 24 hours." / An empty search box with [Search] and [Ask AI]. The server keeps nothing to restore. If the question is still held in the memory of the page already open in this tab, [Ask again] can refill the box. The question is never written to browser storage; while an AI request is on its way, and if it gets no reply, the tab's session storage keeps a one-way hash of that request, a random retry key and the time it saved them, so trying again within 24 hours isn't counted twice (Task 22: written before the request leaves, so a reload in flight replays it). Server retention is never extended. |
| Limit reached (rate) (Proposed) | "Slow down a moment. Try again in {n} seconds." Uses the 429 retry information. For two minutes or more, the per-network hourly and daily limits (Task 22, Proposed): ink-edged box "AI searches from this network are limited for now." / "Try again in 58 minutes." (under an hour) or "Try again after 15:01 UTC." / "Everything else works: keyword search, every case, comparisons and printing." / [Search by keyword instead]. |
| Unexpected error (Task 22, Proposed) | Any page that fails: "Something went wrong." / "This page stopped because of an unexpected error. Try again, or start again from the home page." / [Try again] (reloads) [Home], inside the header and footer; never the router's developer page or the error itself. |

**Counting rules (Owner-approved):**

- An off-topic or operational question does not use a free search, but it
  counts toward the abuse rate limits.
- Cancel counts.
- A withheld summary counts.

**Signing in mid-brief** (Proposed). Google sign-in returns to the page it
started from. When an anonymous visitor signs in from a brief, the server hands
that live brief to the new account. Billing and reading are separate:

- **Billing principal, per step:** fixed when that step's request is admitted,
  and never changed afterwards. Steps admitted before sign-in stay charged to
  the trial identity. Refinements admitted after sign-in are charged to the
  account and its quotas.
- **Read owner, per brief:** this is what moves.

The handover rules:

- **Atomic:** one compare-and-set moves the read owner from trial X to account
  Y. It covers the brief, all its steps, and their idempotent results.
  - It succeeds only when the same browser's trial cookie proves X, within the
    brief's 24-hour life.
  - A second callback, or a concurrent one, is a no-op.
- **Charges stay put:** each step's settled charges, open reservations and
  usage counters stay with that step's billing principal, and the brief's
  expiry time is unchanged. Nothing is re-charged, and nothing moves into the
  account's quota.
- **In-flight work:** a step still running at handover completes normally and
  is readable only by the new owner.
- **Old identity loses access:** after the handover, the trial identity cannot
  read the brief. An idempotent retry from it returns "moved" (sign in to
  view), never a replay or a new run. Like every anonymous AI request, the
  retry takes a fresh Turnstile check first.
- **Signed in elsewhere** (as built in Task 20; Proposed, needs the owner's
  sign-off): when the visitor signed in from another page, a refinement of a
  live brief this browser's trial still owns, or the retry of a request that
  trial made, sent while signed in, moves the brief to the account by the same
  compare-and-set before it runs (the refinement is billed to the account).
  Only the trial proven by this browser's cookie can be moved this way; reads
  never move a brief. On a shared browser this moves the earlier anonymous
  person's brief to whoever signs in there and refines it, which the rule above
  (signing in from the brief's page) does as well.

Tests must cover logout followed by an anonymous replay, concurrent OAuth
callbacks, and in-flight completion. The handover is part of the implementation
security review.

## 6. Phone and tablet (Proposed)

Breakpoints:

| Width | Layout |
| --- | --- |
| Under 640px (phone) | Single column everywhere |
| 640–1023px (tablet) | Facets collapse to a sheet; the drawer covers about 85% |
| 1024px and up (desktop) | As described above |

On a phone:

- **Header:** the mark and the wordmark "AIRCASE" (the same as on desktop) with
  the line "Plane crash & accident investigations" under the wordmark, the AI
  counter ("AI left 2 of 3") on the wordmark's line, and a ☰ menu, centred on
  both lines, holding the nav, Day/Night switch and Sign in. The header keeps its
  height. The line may run under the counter; a counter too long for its place
  is cut short, as before (the longest, "Free AI searches paused for today",
  fits from about 382px).
- **Filters:** a blue filled "Filters (n)" chip at the start of the chip row
  opens a bottom sheet. The sheet has a grab handle, "Filters · Clear all", the
  same facet bars, and a sticky "Show 58 investigations" button.
- **AI results:** the same order as desktop. The chip row scrolls sideways.
- **Case:** opens as a full-screen sheet with the same story order. The top row
  is ✕, "‹ 1 of 3 ›" and "+ Compare".
- **Compare tray:** a bottom bar reading "Compare · 2 cases · Compare →".
- **Compare page:** each strip becomes a stacked card with its fields as
  labelled rows in the same order. The "Same in all" line stays.
- **Dashboard:** one question per card, with horizontal bars and a "Open the
  7,849 landing cases →" link under each chart.

Touch targets are at least 44px on phones.

## 7. Print (Proposed)

"Print for class" appears on compare and the case page. Briefs print through the
browser with the same stylesheet. Print uses:

- black on white, with no graticule, shades or tray
- magenta printed as black, with every AI element keeping its text label and
  glyph, so AI content stays identifiable in grey or black
- hatching kept for cautions
- a header with the page title, case numbers, snapshot date and the page URL;
  the site header's mark and wordmark print, in day colours, but not the line
  "Plane crash & accident investigations"
- the footer "Not an NTSB service · Source: NTSB · printed {date}", then the credit
  line "Built by Mariusz Kotas · mkotas.cz" (the website prints as text)
- strips that never split across pages

## 8. Accessibility (Proposed)

Target **WCAG 2.2 AA**.

- **Contrast:** as measured in §2.2. Recheck any new pair.
- **Not colour alone:** AI labels, glyph words, "DATA CAUTION" and legends
  (§2.1).
- **Drawer and sheets:** `role="dialog"` with `aria-modal`. Focus moves to the
  headline, Esc closes, focus returns to the trigger, and the prev/next buttons
  have accessible names.
- **Checklist:** stage completions are announced through `aria-live="polite"`.
  The timer is not announced.
- **Charts and facets:** every bar is a real button with a full accessible name,
  e.g. "Landing, 7,849 investigations, 32 percent. Open these cases." Each chart
  keeps its sentence as a visible caption. The year chart and map have a
  visually hidden table or summary.
- **Focus:** a visible 2px focus ring. The page is fully usable by keyboard,
  with a logical order.
- **Reflow and targets:** the layout reflows at 320px width and at 200% text
  size. Targets are at least 24px, and 44px on touch.
- **Reduced motion** (§2.6).
- **Language:** plain English. Case numbers are plain text, not images.

## 9. Implementation notes

- Define tokens as CSS custom properties on `:root` and `[data-theme="night"]`,
  and map them into the Tailwind theme. No component hard-codes a colour.
- AI content is a component type, for example `<AiBlock>`, `<AiChip>` and
  `<TimingChip>`. Magenta styling and the AI label come from the component, so
  the colour rule cannot drift.
- Render all AI and NTSB text as text. Build citations and links from
  server-owned IDs (DESIGN §5, §6).
- **The UI needs these from the API:**
  - Per-case summary fields: number, date, aircraft make/model/category,
    registration, city/state, FAR part, purpose, phase, defining event, damage,
    highest injury, conditions, light, sky/visibility/wind, completion status,
    and report link or fallback.
  - Event sequence, findings with their raw `cm_inPC` flag, narrative sections,
    and provenance.
  - Facet aggregations, dashboard aggregates per cohort, snapshot date and
    coverage stats.
  - For briefs: interpretation chips, summary with citations, groups,
    per-case "why" lines, timing values and passage spans, gaps, and stage
    status.
- **Builder:** the chart library for the year chart (Recharts or plain SVG; the
  bars are plain HTML/CSS), the dot-map projection and how it is pre-rendered,
  polling versus SSE for stage status, exact type scale and spacing tokens, and
  the profile-drawing algorithm.

## 10. Decision log

**Owner choices:**

| Topic | Choice |
| --- | --- |
| Visual direction | Sectional |
| Home | Clear sky |
| Results | Briefing sheet, with the case opening in a right-hand drawer |
| Drawer | Story order, single column, no side-by-side columns |
| Compare | Flight strips |
| Progress | Checklist |
| Filters | Facets with counts |
| Dashboard | Questions |
| Night mode | Panel |

The owner also approved the §5 states and copy not marked Proposed, including the
counting rules.

**Proposed calls** (designer; check while reading):

1. The drawer and case headline come from a template over coded fields, not the
   AI.
2. Example chips fill the box; they don't run.
3. Enter runs the free Search; Ask AI needs a click or Ctrl/Cmd+Enter.
4. Filters, the open case and compare selections live in the URL.
5. Empty evidence groups show "none".
6. Questions that aren't about mechanical cause get one "Examples found" list
   instead of evidence groups.
7. The Refine button shows the AI counter, and a brief ends after three
   refinements.
8. Compare without a brief shows NTSB columns only.
9. Version one shows deterministic data cautions only.
10. Muted is darkened to `#58616B` for AA contrast on `tint`.
11. Day/Night follows the device until changed, is remembered per device, and
    printing is always day.
12. Night placards appear only at night.
13. Breakpoints 640/1024. On phones the case is a full-screen sheet and filters
    are a "Filters (n)" sheet.
14. The full case page, account page, brief-expired and rate-limit states, print
    rules and accessibility rules as written above.
15. In version one, AI content lives only inside the viewer's own brief. Explore,
    case pages, keyword compare and the dashboard stay NTSB-only and cacheable.
16. Brief controls show "· uses 1" before any paid action. Gap actions and
    "Show keyword results" are free. Earlier steps stay readable through a step
    switcher.
17. Clarification, statistics, comparison and off-topic scope results get
    static, non-chat responses and are not charged.
18. The event is the unit for multi-aircraft cases, with per-aircraft sub-rows
    and ambiguity shown, not guessed.
19. Keyword search requires all words, with stemming and a small aviation
    synonym list. Snippets come from the matching section.
20. Records outside the completed set are browsable with their raw status
    code. They are classed as in progress or status unknown only after the
    mapping is verified ("other records" until then), instead of "still open".
21. The counter always shows searches left. A coarse public AI status drives
    labels before anyone clicks. New copy covers signed-in caps, the
    "free searches paused" state and the extra check.
22. A live anonymous brief moves to the new account on sign-in from the same
    browser.
23. Attribution tags such as "PILOT'S ACCOUNT · AI READING" appear when the
    brief attributes a quote to a pilot or witness.
24. The working mockups are kept in `docs/mockups/`, without map dot data.

**Owner decisions after review** (2026-10-21):

- Keep the anonymous trial, with live availability labels.
- No training-email opt-in in the first beta. It returns with an email
  provider and email/password accounts.
- The language-model provider is switchable by operators at deployment,
  starting with Anthropic. Nothing about the provider is visible in the
  interface.

- The monthly AI budget is $100 while the Anthropic credit lasts (DESIGN §9).
  With the default Opus answer model, anonymous visitors share about 7 AI
  searches a day, so the "free searches paused" state will still be common.
  The owner picks the production answer model from the evaluation results.

**Owner decisions** (2026-10-24):

- The product is renamed **AirCase**, with the tagline **"aviation casebook"**; its
  live domain is `https://aircase.app`. The user-visible name is AirCase everywhere:
  the header wordmark, every page title ("{page} · AirCase"), the sign-in dialog
  ("Sign in to AirCase"), the error and not-found pages, the print header and the
  case page's provenance line. Where the long form helps it read "AirCase · aviation casebook":
  the home page's title and the page before the script runs (the same day the home
  page's title became "AirCase · Plane crash & accident investigations", below). The
  wordmark keeps the Sectional typography (§2.5) with letter-spacing adjusted for the
  shorter word.
  Code identifiers, package names, the `apps/aviation-investigations` directory,
  database and index names, Compose projects, environment variables and the stored
  `casebook-*` browser keys are not renamed. The working mockups in `docs/mockups/`
  carry the new name too; where they differ from this document, this document wins.
- The footer says the app was built by **Mariusz Kotas** and links his website
  **mkotas.cz** (§3); the About page has a short "Built by" section with his name,
  the website and the contact e-mail **m@mkotas.cz** as a `mailto:` link (§4.8).
  The footer first carried the e-mail address; the owner replaced it with the
  website the same day and kept the address on the About page. This is
  intentional public information requested by the owner, not personal data to
  scrub.
- The About page describes AirCase as it is: keyword search with filters, a page
  for each case, Compare (up to four cases) and the dashboard, with the NTSB data
  source and attribution; it says the AI features are not available yet, and
  promises none.
- Search engines and link previews (Owner request, SEO): the case page's tab title
  is "{headline} ({event year}) · NTSB {ntsbNo} · AirCase" (§4.5), so a search
  result names the aircraft, what happened, where, the year and the case number.
  Every other title stays as it was. The server sends each page's title, description
  and share image in the page's head, with the same title the page then shows
  (README, "Search engines and link previews").
- The visual identity (Owner request: a memorable mark for the header and the
  browser tab, icons and a share image for links, and a plain-language line in the
  header so that strangers understand at once what the site shows). From
  side-by-side options the owner picked:
  - the mark **C, "Case file"**: a case folder carrying an aircraft (§2.5), over
    "Profile" (a flight profile whose event ring doubles as a magnifying glass) and
    "Runway A". It is the header's mark, the favicon (in place of the compass, which
    stays on the home page), the app icons and the share card's mark;
  - the header line **"Plane crash & accident investigations"** (§3), over "NTSB
    plane crash investigations" and "What investigators found in US plane
    crashes": it uses the words people search with, and "accident" keeps it true,
    since many cases are not crashes. The home page's title becomes "AirCase ·
    Plane crash & accident investigations"; the tagline "aviation casebook" stays
    on the About page and as the home page's JSON-LD `alternateName`. The site
    description becomes "Search NTSB investigations of US plane crashes and
    aviation accidents since 2008: what happened, the probable cause and what
    investigators found.";
  - the **share card** as reviewed (§2.5), with that line as its headline;
  - at night the **wordmark loses its engraved-placard box** (§2.5, §2.8); every
    other placard keeps it.

  The working mockups in `docs/mockups/` predate the mark and the header line; this
  document wins.
