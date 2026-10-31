# Stitch reference screens

Generated with Google Stitch from [DESIGN.md](../DESIGN.md) and the page inventory in
[redesign-brief.md](../redesign-brief.md). Stitch project: `15134504745982242024`
("Kinmesh workspace redesign"), design system asset `6698317491358575704`.

These are **direction references**, not specs. Stitch invented some elements that
Kinmesh does not support; do not implement them unless the backend gains the feature.

| File                         | Page                             | Stitch screen id                   |
| ---------------------------- | -------------------------------- | ---------------------------------- |
| `p2-chat-desktop.png`        | P2 Channel chat                  | `b8844e2853154fe4810f4f853f4af3ec` |
| `p3-board-desktop.png`       | P3 Task board (7 status columns) | `7bd08c651b2b47a390a217e6d438209f` |
| `p4-task-drawer-desktop.png` | P4 Task detail + human decision  | `31d7278f25094631bff869951b697d90` |
| `p5-team-roster-desktop.png` | P5 Team roster + register agent  | `b804cfe750f34f31bab162cc343f54f8` |

## Still to generate

P1 sign-in / first-owner setup, P6 agent detail drawer (AG-UI recorded vs native T3),
P8 system states (offline, refreshing, empty, permission loss), and mobile chat, board
and decision sheet. Prompts for each are in this PR's history (see the brief's page
table for intent).

## Elements to ignore (not supported by the backend)

- Rich-text toolbar, attachments, "Task mode" / "Ask agent" composer buttons
- Branch, test counts, diff stats and runtime/latency footers
- Threads, Decisions and Direct messages navigation entries
- A "Backlog" column (Kinmesh has exactly seven statuses, starting at proposed)
- "LIVE" presence badges: show only "Last recorded: <state> · <time>"
- Pre-filled decision notes and pre-ticked criteria: criteria are not individually
  checkable in the API, and the note must be written by the human
