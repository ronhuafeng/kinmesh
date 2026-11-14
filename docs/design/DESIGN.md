# Kinmesh design system

## Character

A calm, precise workroom where people and AI agents work side by side. Warm paper and
deep ink, one confident green, and a slight tool-like edge: hairline ink borders,
monospaced labels for identifiers and status. Agents feel like teammates with
personality, never like settings. The human decision is always the most prominent
thing on the screen.

Words: trustworthy, legible, alive, unhurried, honest about what is verified.

## Principles

Every screen is judged by one standard: don't make people think, and show nothing
that isn't needed. Check a change against these before it ships.

**Overall**

1. Every new piece matches the existing style and is beautiful and friendly. Never
   drop default controls (boxed inputs, full-width selects, block buttons) into a
   designed surface; a control looks like what it creates — a new agent is a tile
   whose face fills in as you type its name.
2. One element per job, reused everywhere: `icon-button`, its round `confirm`
   variant, the `+` add button, `Avatar`, `Presence`. No one-off variants; keep
   selectors narrow so styles don't leak into shared elements.

**Remove, don't explain**

3. No warnings or hints that draw attention to a risk; fix the cause instead.
4. No annotation text: no "(human)/(agent)", no role or "you" labels, no counts
   ("3 open", an empty "0"), no "updated 3m ago", no explanatory sentences.
5. Say each thing once. Nothing repeats the navigation (no "# channel" or agent title
   when the sidebar shows it, no "Team" heading under the Team tab) or another part of
   the page (the model lives in About, not also in the status card). Leave out what
   people don't use (models on the Team page).
6. Every row earns its space.

**No folds, no drawers**

7. No disclosure widgets (`<details>`, "Add details", "More", "Technical details").
   Folds hide information; show it or leave it out.
8. No drawers or overlays for content. A task, a new task, the Inbox, Settings and an
   agent open as pages in the main area. Creating is the same page as viewing: a new
   task is its task page, empty; once created it stays on screen as that task.

**Navigation**

9. No headings where the structure already says it (a separator, not "In this
   channel"); no back links — the sidebar and tabs navigate, Esc goes back. A phone
   is the exception: no sidebar sits beside a channel or page and there is no Esc, so
   its bar leads back.
10. The object is the link: a name, a card, a row. No separate "Open" buttons.
11. One current place is highlighted at a time: a channel or person in the sidebar, or
    a tab. Plain words ("Inbox").
12. A reload keeps the place and the unsent work: every page has an address, Back
    works, drafts survive in the tab.

**Faces and presence**

13. Icons over labels where the meaning is plain (`+`, inbox, sign out). Every avatar
    is round, people and agents alike; an agent may have a picture.
14. Presence reads the same for everyone: "● Online / ○ Offline" under a face, a dot
    beside a name in a list. The team is a gallery of faces; adding is a tile in it.

**Input**

15. Hints live in placeholders. Fields typed in place look like the text they become:
    no box, one underline that turns green, no focus halo. "Done when" is written as a
    checklist (Enter starts the next row). Choosing a person shows their face, or an
    empty dashed one.

**Layout**

16. Alignment is exact and measured, not eyeballed: siblings on a row share size,
    padding and line height; content aligns to its anchor; shared edges are truly
    shared; icons are truly centred.
17. Balance: the composer at the bottom, equal-height board columns, no dead areas.
    No white cards for layout — content sits on the paper, grouped by space and
    hairlines.
18. Order by importance: the decision waiting on you comes first; long lists (runs)
    come last. Views are tabs on the left; there is no page title above them.

**Process**

19. Redesigns may explore with Google Stitch; these principles filter what it
    proposes, so leave out what the generator invents (step numbers, counts, shortcut
    hints, navigation repeated in the page).
20. Verify UI in a real browser: screenshot it and measure the boxes.

## Color

Values live in [web/style.css](../../web/style.css) (`:root`, redefined for dark mode);
it is the authority. Use the custom property for its role, never a raw colour.

| Token                                        | Role                                                  |
| -------------------------------------------- | ----------------------------------------------------- |
| `--paper`                                    | App background; content sits on it                    |
| `--surface`, `--raised`                      | Controls, popovers and inputs; a hovered row          |
| `--sunken`, `--hover`                        | Board columns, empty tiles; hover fill                |
| `--ink`, `--ink-muted`, `--ink-subtle`       | Primary, secondary and quiet text                     |
| `--hairline`, `--hairline-strong`            | Dividers; control borders                             |
| `--primary` (+ `-hover`, `-soft`), `--focus` | Primary actions, selection, links; focus ring         |
| `--human`, `--agent` (+ `-soft`, `-text`)    | Identity colour of people (ochre) and agents (indigo) |
| `--decision` (+ `-soft`, `-text`)            | The decision waiting on you, Inbox; used sparingly    |
| `--danger`, `--ok`, `--warn` (+ `-soft`)     | A problem; done; offline or stale                     |
| `--s-<status>`                               | Task status dot and its stage column, one per status  |

## Typography

- UI and headings: **Geist**. Headline weights 600–700 with slight negative tracking.
- Labels, IDs, timestamps, status text, counts: **JetBrains Mono**, 11–12 px, uppercase
  for column headers.
- Body 14–15 px, line height 1.55. Message text 15 px.
- The team name only: the system's **Song** serif (Songti SC, then Source Han / Noto
  Serif CJK), 700, slightly open tracking, 18 px (15 px when long). Nothing else uses
  it.

## Shape and spacing

- Radius: 8 px cards and inputs, 999 px pills, 50% for every avatar.
- Borders: 1 px hairline; selected or focused items use a 1.5 px ink or primary border.
- Shadows: almost none. Elevation comes from borders and surface contrast.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48.

## Components

- **Avatar**: round for everyone; an agent's picture when it has one, otherwise the
  initial on the identity colour (ochre for people, indigo for agents).
- **Presence**: "● Online / ○ Offline" under a face (Team), a dot beside a name
  (sidebar, mention list). A person is online while signed in; an agent while a
  worker can wake it, so an agent nobody runs is offline before anyone asks it.
- **Message**: avatar, name, time, topic pill; consecutive messages from the same
  author are grouped. Bodies render a safe Markdown subset (paragraphs, lists,
  quotes, headings, code, emphasis, http(s) links opening in a new tab). A mention
  already written as `@Name` gets no second chip. An agent's reply shows the message
  it answers and carries a line only for an exception (failed, stopped, shortened);
  what ran it lives with the run on the agent's page.
- **Delivery line**: under a message that mentions an agent, and on a task handed to
  one, one line per agent in plain words: will pick this up, isn't connected, is
  working on it, is waiting for an approval in T3, replied (linking the reply, with
  how long it took), is stuck (what was lost and the one fix — re-enable the agent,
  add it back or open its setup — next to a retry), or never picked this up. The
  machine state is only a tooltip.
- **Composer**: multi-line input with the `@` mention popover, docked at the bottom
  of the chat; hints in the placeholder.
- **Channels**: the sidebar lists joined channels; a channel you left can be rejoined
  by name. A channel where something waits on you ends in a decision-coloured dot, the
  size of a presence dot and on its edge. The current channel holds its topics under
  it like a tree on a hairline trunk: "All", the ten most recently active, "More
  topics" for the rest, a `+` that starts one, and "Leave channel". On a phone the
  topics are pills above the conversation.
- **Board**: five stage columns, the stages of the lifecycle: Proposed → Working →
  Review → Human sign-off → Done. Rework stays in Working (marked "Sent back");
  cancelled work goes to Done (marked "Cancelled", hidden until asked for). Columns sit
  on the paper with a hairline under each name, no boxes or counts; a card's column is
  its status. A card shows its title, what it asks of you, and owner/reviewer faces;
  those two markers are its only labels. A new task starts from the dashed
  `+` card at the end of Proposed.
- **Task page** (new or existing, one layout): lifecycle bar; large title;
  description; on the left the decision waiting on you (orange rule), "Done when" as a
  checklist, then history as one timeline with faces and run references inline; on the
  right owner, reviewer, acceptor and the topic.
- **Decision**: the latest note that led here, one note field ("Note for the
  record"), the actions as buttons; disabled with a reason only when offline.
- **Agent page**: status card with its actions, requests in this channel, About
  (every fact visible, picture to change, Team MCP credential), runs as a table at the
  bottom. A run shows what the agent last reported apart from what T3 confirms on
  **Check in T3**; **Open in T3** appears only when T3 supplied the link.
- **Agent setup**: one next step at a time. First **Connect T3**, once per team: a T3
  on this machine is found on its own, otherwise paste its MCP URL; approve
  Supervised in T3. A read-only approval shows as the next step, never as success.
  Then choose what the agent runs on from one list of every provider's models. After
  that a single line says the agent is ready (or its worker is starting), with
  **Change model**, **Reconnect** and **Disconnect**, and offers to add the agent to
  the channel on screen when it isn't in it. **Run the worker yourself** opens a page
  for operators: runtime preferences, the worker credential (issue, rotate, revoke),
  the `npm run t3:auth` step and an `inbox.json` binding without secrets.
- **Credential once**: a newly issued token appears once, with copy and download,
  and is gone when dismissed.
- **Team**: a gallery of faces with names and presence; the last tile adds an agent.
- **Inbox**: the tab after Team, with how many things wait on you. Everything across
  the team waiting on you, one list, newest first: tasks for your sign-off, review or
  rework; stuck deliveries; agents with queued work and no worker. A row is a face, what it is, where and when, an orange or red rule for a
  decision or a problem; the row opens where it is resolved (task, channel or agent).
  A row leaves when its cause is resolved; there is nothing to dismiss. Expired
  deliveries are not listed; they stay on their message's delivery line.
- **Settings**: your own row among the sidebar's people opens your page; the account
  is not shown anywhere else, so the page has no face or name of its own. It holds
  only **Sign out everywhere**, a quiet row in the danger colour (and **Sign out** on
  a phone).
- **Team name**: the organization's name as Feishu gives it, never typed here, heads
  the sidebar above search as a wordmark — no logo or avatar. One line; a name of more
  than 12 characters is set smaller and wraps onto a second line, cut there with an
  ellipsis, its full name on hover. Its text starts on the headings' edge.
- **Sign in**: the brand and the team's promise beside one card, **Welcome** and a
  single **Sign in with Feishu** button (a link drawn as the primary button). When
  Feishu sends someone back unsigned, the card says why in one line — not part of
  this organization, took too long, or Feishu couldn't be reached — and the reason
  leaves the address, so a reload starts clean. Turning back at Feishu returns here
  silently.
- **Sign out**: the power icon at the far right of the header.
- **Opening the workspace**: quiet. A load that is quick shows nothing; one that takes
  more than 0.6 s fades in the brand, "Opening your workspace…" and a skeleton board
  (at once without motion). Only a failure says "Workspace unavailable", why, and offers
  **Try again**.
- **Connection pill**: absent while healthy; dot + "Refreshing… / Disconnected" with
  last time and **Reconnect**; offline turns into a full-width stale banner. **Refresh
  now** lives in the command palette (⌘K / Ctrl+K).
- **Uncertain send**: when a request's outcome is unknown, the form keeps exactly what
  was sent and offers **Retry same action**; nothing is resent on its own.

## Phone

Below 720 px the places stack instead of sitting side by side:

- **Home** is the sidebar: the team name, search, the channels (full-width rows, the waiting dot),
  then the team as the gallery of faces with its add tile. No channel is current here.
- **Bottom tabs**: Home, Inbox (with how many things wait on you) and You (your face),
  under Home and the pages they open.
- **A channel** has the screen under a bar: back to Home, `# name`, then Chat | Board.
  Its topics are pills above the conversation; there is no bottom bar.
- **A page** (agent, task, a worker you run) opens under its own bar: back, then what it
  is — the agent's name, or a task's channel since its title leads the page.
- **You** ends with Sign out, in the danger colour; the header's power icon is for wider
  screens.

## Tablet

From 721 to 1279 px the sidebar stays beside the content, sized for a finger (rows of
44 px). Touch has no Esc, so a page leads back from a bar at its top-left; the sidebar
already says where you are, so the bar holds only the way back. Held upright (below
1024 px) the board shows one stage at a time and a page replaces the view. Held wide,
an open task sits beside the board — one stage, its card marked by a green edge —
instead of replacing it.

## Motion

Short and purposeful (160–320 ms, ease-out or gentle spring). Cards travel between
status columns, pages fade in where the view was, checklists draw their ticks on
acceptance. Everything honours reduced-motion preferences.

## Voice

Say what is true for the person, in their words: "Ada is waiting for an approval in T3",
not what the system disclaims ("Execution does not imply acceptance"). Every honesty
guarantee stays; only its wording changes:

- **Explicit acceptance.** Only the designated human accepts a task, with a note; no
  provider result, review or refresh implies it.
- **Recorded is not verified.** What an agent reported is shown as reported, with its
  time; T3's own status is a separate, explicit check.
- **Stale data says so.** A failed refresh keeps the last data, marks it stale and
  blocks sending until a reconnect succeeds; a routine refresh never pauses anything.
- **Text is text.** Message bodies are never rendered as HTML.

- No protocol names or version counters in front: AG-UI, snapshot and `vN` stay out
  of the interface. T3 thread and run IDs appear only where they are the subject (the
  agent's runs, a history line), small and in mono, after the sentence.
- The machinery is silent when healthy: no heartbeat, no "connected" badge, no polling
  interval. Show state only when it needs the person.
- History and status are sentences ("You accepted it: '…'"), never API verbs.
