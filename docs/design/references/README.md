# Stitch reference screens

Generated with Google Stitch from [DESIGN.md](../DESIGN.md) and the page inventory in
[redesign-brief.md](../redesign-brief.md). Stitch project: `15134504745982242024`
("Kinmesh workspace redesign"), design system asset `6698317491358575704`.

These are **direction references**, not specs. Stitch invented some elements that
Kinmesh does not support; do not implement them unless the backend gains the feature.

| File                             | Page                             | Stitch screen id                   |
| -------------------------------- | -------------------------------- | ---------------------------------- |
| `p2-chat-desktop.png`            | P2 Channel chat                  | `b8844e2853154fe4810f4f853f4af3ec` |
| `p3-board-desktop.png`           | P3 Task board (7 status columns) | `7bd08c651b2b47a390a217e6d438209f` |
| `p4-task-drawer-desktop.png`     | P4 Task detail + human decision  | `31d7278f25094631bff869951b697d90` |
| `p5-team-roster-desktop.png`     | P5 Team roster + register agent  | `b804cfe750f34f31bab162cc343f54f8` |
| `p1-sign-in-setup-desktop.png`   | P1 Sign in / first-owner setup   | `5114f0c040a54ba29ef36f8a1867fe51` |
| `p6-agent-drawer-desktop.png`    | P6 Agent detail drawer           | `0848fe6b5c454b09a8a4b341e9f7b4f7` |
| `p8-system-states-desktop.png`   | P8 System states (2×2 sheet)     | `b101e6eed9ee47c59ac5e82e36845c23` |
| `m-p2-chat-mobile.png`           | Mobile channel chat              | `70adc915214d486289f10a7206dc2090` |
| `m-p3-board-mobile.png`          | Mobile board (column switcher)   | `59cdad48dfe248c8861fbe11ee3b22a8` |
| `m-p4-decision-sheet-mobile.png` | Mobile task decision sheet       | `7565df3e2ed74bddadee14668c809de8` |

P7 (Needs you inbox) is covered by the "Waiting for you" strip and the board's
"Needs me" filter rather than a separate screen.

## Elements to ignore (not supported by the backend)

- Rich-text toolbar, attachments, "Task mode" / "Ask agent" composer buttons
- Branch, test counts, diff stats and runtime/latency footers
- Threads, Decisions and Direct messages navigation entries
- A "Backlog" column (Kinmesh has exactly seven statuses, starting at proposed)
- "LIVE" presence badges: show only "Last recorded: <state> · <time>"
- Pre-filled decision notes and pre-ticked criteria: criteria are not individually
  checkable in the API, and the note must be written by the human
- Status bars and chrome: version badges, "runtime local · port", daemon/latency
  footers, "Step 1 of 1", "Tier-1 unlocked", spec headers and "ALL TESTS PASSING"
- Sidebar entries for Runtime Health, Settings, "Invite Teammate or Agent", and
  channel tabs such as Linked Tasks, Decisions and Canvas
- "SYNCHRONIZED" / "Live" badges and "Native verified" stamps outside the agent
  drawer: native status is only shown after an explicit per-execution check
- Named execution steps (Workspace mounted, Tests running…): the timeline shows the
  recorded AG-UI states as reported
- Reconnection countdowns, delta replay counters, "Reset key", "Switch org" and
  pre-filled usernames on the access-lost screen
- "Last recorded" lines inside chat messages, PR numbers and "TASK-8834" style IDs
- "3/3 criteria verified" and "Approved" reviewer badges derived from criteria
