# Kinmesh design system

## Character

A calm, precise workroom where people and AI agents work side by side. Warm paper and
deep ink, one confident green, and a slight tool-like edge: hairline ink borders,
monospaced labels for identifiers and status. Agents feel like teammates with
personality, never like settings. The human decision is always the most prominent
thing on the screen.

Words: trustworthy, legible, alive, unhurried, honest about what is verified.

## Color

| Token             | Light     | Dark      | Use                                              |
| ----------------- | --------- | --------- | ------------------------------------------------ |
| paper             | `#F6F4EE` | `#121411` | App background                                   |
| surface           | `#FFFFFF` | `#1A1D19` | Cards, drawers, composer                         |
| surface-sunken    | `#EFEDE5` | `#161915` | Rails, board columns                             |
| ink               | `#1C1F1A` | `#ECEDE6` | Primary text, strong borders                     |
| ink-muted         | `#5E6459` | `#A2A89C` | Secondary text                                   |
| hairline          | `#DEDBD0` | `#2B2F29` | Borders and dividers                             |
| primary (Kinmesh) | `#1B5544` | `#6FBF92` | Primary actions, selection, links                |
| human             | `#B7791F` | `#E0B25C` | Human identity accent (avatars, author tags)     |
| agent             | `#3F5BA9` | `#93A9EC` | Agent identity accent (avatars, author tags)     |
| decision          | `#C2410C` | `#F28A5B` | "Needs you" — the human decision; used sparingly |

The board has **five stage columns**, the same stages as the lifecycle: Proposed → Working → Review → Human sign-off → Done. Rework stays in Working (marked "Sent back"); cancelled work goes to Done (marked "Cancelled", hidden until asked for). A card names only these exceptions; its column is its status.

Task status colours (dot + label, also the colour of the stage column):

| Status           | Colour    | Meaning                      |
| ---------------- | --------- | ---------------------------- |
| proposed         | `#8A8F84` | Not yet claimed              |
| in-progress      | `#3F5BA9` | Someone is working           |
| review-requested | `#8E5BB5` | Waiting for technical review |
| awaiting-human   | `#C2410C` | Waiting for human sign-off   |
| rework-requested | `#B42318` | Sent back                    |
| accepted         | `#1B7A4A` | Human accepted               |
| cancelled        | `#A3A39B` | Closed without acceptance    |

## Typography

- UI and headings: **Geist**. Headline weights 600–700 with slight negative tracking.
- Labels, IDs, timestamps, status text, counts: **JetBrains Mono**, 11–12 px, uppercase
  for column headers.
- Body 14–15 px, line height 1.55. Message text 15 px.

## Shape and spacing

- Radius: 8 px cards and inputs, 999 px pills, 12 px drawers.
- Borders: 1 px hairline; selected or focused items use a 1.5 px ink or primary border.
- Shadows: almost none. Elevation comes from borders and surface contrast; drawers get
  one soft shadow.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48.

## Components

- **Identity chip**: avatar (humans square, agents round with a small runtime glyph),
  name, role, and for agents the runtime/model preference in mono.
- **Message**: avatar, name, HUMAN/AGENT tag, time, topic pill; consecutive messages
  from the same author are grouped. Mentions render as identity-coloured chips.
- **Composer**: multi-line input, `@` mention popover, topic pill, send button; docked
  at the bottom of the chat.
- **Task card (board)**: mono task number, title, owner and reviewer avatars, criteria
  count, age; a marker only for exceptions (Sent back, Cancelled). "Needs you" cards carry
  a decision-orange left edge.
- **Task drawer**: title, status dot, lifecycle stepper (Proposed → Working → Review →
  Human sign-off → Done), criteria checklist, owner/reviewer, decision buttons with a
  required note, history timeline, execution references.
- **Decision buttons**: primary "Accept task" in green, "Request rework" as an outlined
  danger button; disabled with an explanation when offline.
- **Agent activity**: timeline of AG-UI recorded states ("Last recorded: waiting · 2 min
  ago · by agent"), clearly separated from "Native verified at …" T3 checks.
- **Connection pill**: dot + "Snapshot connected / Refreshing… / Disconnected" with read
  time; offline turns into a full-width stale banner.

## Motion

Short and purposeful (160–320 ms, ease-out or gentle spring). Cards travel between
status columns, drawers slide from the right, checklists draw their ticks on
acceptance. Everything honours reduced-motion preferences.
