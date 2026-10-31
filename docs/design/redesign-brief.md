# Workspace redesign brief

Status: draft for review (reference images pending). Scope: `web/` only. Backend
contracts, security rules and the explicit human-acceptance model do not change.

## 1. Target

Kinmesh started from the [Raft](https://raft.build/zh-cn/) idea: humans and AI agents
are teammates in one durable workspace. Agents have identity and memory, pick up and
hand off work, and stay visible while they do it. Humans set direction, review, and make
the final call. Kinmesh implements this with its own team state, the
[AG-UI](https://github.com/ag-ui-protocol/ag-ui) protocol for agent activity, and T3 Code
as the external execution runtime.

The current web UI exposes the data but not the experience. It is organised by entity
(Conversation / Tasks / Agents tabs). Agents appear as configuration records, task
state is hidden in dropdown forms, and agent activity sits behind three clicks.

## 2. Gap analysis

Legend: **F** = frontend-only change. **D** = backend already returns the data but the
UI hides or under-uses it. **B** = needs backend work (out of scope; listed for the
roadmap).

| Raft experience                                  | Kinmesh today                                            | Gap | Plan                                                                            |
| ------------------------------------------------ | -------------------------------------------------------- | --- | ------------------------------------------------------------------------------- |
| Agents are named teammates with role and runtime | Agent card shows name, role, UUID; preferences in a fold | D   | Identity chip everywhere: avatar, name, role, runtime/model preference          |
| Team roster / org view                           | Flat card grid inside a tab                              | F   | Dedicated Team page; humans and agents together; channel membership per person  |
| Reporting lines (lead → members)                 | No data                                                  | B   | Not drawn                                                                       |
| Channels + topics                                | Channel list; topic as a select box                      | F   | Topic rail/pills; topic shown on messages and tasks                             |
| Threads, DMs                                     | Not supported                                            | B   | Not drawn; topics serve as lightweight threads                                  |
| Files tab                                        | Not supported                                            | B   | Not drawn                                                                       |
| @mentions in the composer                        | One agent picked from a select box                       | D   | Inline `@` autocomplete, multiple mentions (API allows 20)                      |
| Turn conversation into work                      | Task form has no message link                            | D   | "Make task from message" action; task records `sourceMessageId` / `topicId`     |
| Task board by status with counts                 | Cards grouped in three lanes                             | F   | Board with **7 columns**, one per real status, with counts                      |
| Numbered, scannable task cards                   | Large cards with embedded forms                          | F   | Compact cards; detail opens in a side drawer                                    |
| Clear human approval moment                      | "Action" select + note + submit                          | F   | Explicit decision buttons (Accept / Request rework …) with a required note      |
| Work keeps moving while you are away             | 15 s snapshot polling                                    | F   | "Since you were away" markers; status changes animate in on refresh             |
| Agent activity visible in context                | Separate panel under Agents tab                          | D   | Agent drawer with AG-UI last-recorded state timeline + explicit native T3 check |
| Live streaming / tool calls (AG-UI events)       | Server exposes snapshots only                            | B   | Snapshot semantics stay labelled; no fake streaming                             |
| Presence (online/working)                        | Not tracked                                              | B   | Show last recorded runtime state, labelled with its time, never as "online"     |
| Bring your own agent / runtime                   | Owner API for grants and profiles                        | D   | Register-agent flow shows runtime/provider/model preferences                    |

Non-negotiables carried into every screen:

- **Acceptance is explicit.** Only the designated human can accept a task, with a note.
  No provider result, review or poll implies acceptance.
- **Recorded is not verified.** AG-UI reports show "Last recorded …" with time and
  provenance. Native T3 status is a separate, explicit read.
- **Offline disables actions.** A failed refresh keeps the last snapshot, labels it
  stale, and disables mutations until reconnect.
- **Text is text.** Message bodies are never rendered as HTML.

## 3. Information architecture

```
┌ Left rail ─────────┐ ┌ Main ────────────────────────────────────────────┐ ┌ Drawer ─────┐
│ Team switcher       │ │ Channel header: #name · topic pills · people     │ │ Task detail  │
│ ● Needs you (n)     │ │ ┌ Chat ┐ ┌ Board ┐ ┌ Team ┐   (segmented control)   │ │ or           │
│ Channels            │ │                                                  │ │ Agent detail │
│   # general         │ │ view content                                     │ │              │
│   # design          │ │                                                  │ │              │
│ Teammates           │ │                                                  │ │              │
│   ◐ Ada · dev       │ │                                                  │ │              │
│ You · sign out      │ └──────────────────────────────────────────────────┘ └──────────────┘
```

| Page / state             | The person comes here to…                                | Key content                                                                 |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------------- |
| P1 Sign in / first owner | Get in, or claim a new install safely                    | Two modes, setup-secret guidance, privacy note                              |
| P2 Channel chat          | Talk with people and agents; hand work to an agent       | Messages by person/agent, topics, mentions, composer with `@`, message→task |
| P3 Task board            | See every promise and where it is stuck                  | 7 status columns, counts, compact cards, filters (mine / needs me)          |
| P4 Task detail (drawer)  | Decide: claim, hand off, review, **accept or send back** | Criteria checklist, lifecycle, owner/reviewer, decision buttons, history    |
| P5 Team roster           | Know who is on the team and in which channel             | Humans and agents, role, runtime/model preference, join state, invite       |
| P6 Agent detail (drawer) | Check what an agent last did, verify natively if needed  | Identity, AG-UI recorded state timeline, executions, native T3 check        |
| P7 Needs you inbox       | Clear everything waiting on me across the channel        | Review / sign-off / rework items with one-click open                        |
| P8 System states         | Understand empty, loading, offline, permission loss      | Empty channel, skeletons, stale banner, signed-out purge                    |
| Mobile (P2, P3, P4)      | Read and decide on the go                                | Bottom nav, single-column board with column switcher, full-screen drawer    |

## 4. UI element exploration

| Need                      | Options considered                            | Leaning                                              |
| ------------------------- | --------------------------------------------- | ---------------------------------------------------- |
| Switch views in a channel | Tabs · segmented control · rail icons         | Segmented control with sliding indicator             |
| Choose a topic            | Select · pill row · left sub-list             | Horizontal pill row with "+ topic"                   |
| Mention                   | Select · `@` autocomplete popover             | `@` popover, chips in the composer                   |
| Task action               | Select + submit · button group · split button | Contextual button group; note field appears on click |
| Task detail               | Inline expand · modal · side drawer           | Side drawer (full screen on mobile)                  |
| Status                    | Text badge · dot + label · column position    | Column position + coloured dot label                 |
| Feedback after an action  | Inline text · toast · card animation          | Card moves to new column + toast with undo-free note |
| Quick navigation          | Sidebar only · ⌘K command palette             | ⌘K palette (channels, tasks, agents)                 |

## 5. Motion

Motion explains state change; it never decorates. All motion respects
`prefers-reduced-motion`.

| Moment                        | Motion                                                          | Duration      |
| ----------------------------- | --------------------------------------------------------------- | ------------- |
| View switch                   | Segmented indicator slides; content cross-fades 8 px            | 180 ms        |
| Task changes status           | Card travels to its new column (FLIP / View Transitions API)    | 320 ms spring |
| Human accepts                 | Checklist ticks draw in sequence, card settles into Accepted    | 400 ms total  |
| Drawer open / close           | Slide from right with backdrop fade; focus moves into drawer    | 220 ms        |
| New message on refresh        | Fade + 6 px rise; "new" divider line                            | 200 ms        |
| Agent recorded state `active` | Slow breathing ring on avatar (labelled, not "online")          | 2.4 s loop    |
| Refreshing / offline          | Status dot pulse while loading; banner slides down when offline | 160 ms        |
| Loading                       | Skeleton shimmer for board columns and messages                 | 1.2 s loop    |
