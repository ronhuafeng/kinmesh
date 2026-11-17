# Kinmesh design system

## Character

A calm, precise workroom where people and AI agents work side by side, built like a
native iOS and macOS app: a grey grouped canvas, white content, hairline separators,
translucent material and a little depth where things layer, the system's own type at a
generous size, and one deep green. Agents feel like teammates with
personality, never like settings. The human decision is always the most prominent
thing on the screen.

Words: trustworthy, legible, alive, unhurried, honest about what is verified.

## Principles

Every screen is judged by one standard: don't make people think, and show nothing
that isn't needed now. The one exception is the settings map, which shows where
Kinmesh is going: its planned sections are listed, quietly (see **Settings**).
Check a change against these before it ships.

**Overall**

1. Every new piece matches the existing style and is beautiful and friendly. Never
   drop default controls (boxed inputs, full-width selects, block buttons) into a
   designed surface; a control looks like what it creates — a new agent is a tile
   whose face fills in as you type its name.
2. One element per job, reused everywhere: `icon-button`, its round `confirm`
   variant, the `+` add button, the segmented control, `Avatar`, `ChannelIcon`,
   `Presence`. No one-off variants; keep selectors narrow so styles don't leak into
   shared elements.

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
8. No drawers or overlays for content. A task, a new task, the Inbox, a settings
   section and an agent open as pages in the main area; menus are the one thing that
   pops over the page. Creating is the same page as viewing: a new
   task is its task page, empty; once created it stays on screen as that task. The one
   exception is navigation: below 900 px the open sidebar floats over the content's
   edge (see **Sidebar**).

**Navigation**

9. No headings where the structure already says it (a separator, not "In this
   channel"); no back links — the sidebar and tabs navigate, Esc goes back. A phone
   is the exception: no sidebar sits beside a channel or page and there is no Esc, so
   its bar leads back.
10. The object is the link: a name, a card, a row. No separate "Open" buttons.
11. One current place is highlighted at a time: a channel or person in the sidebar, or
    a tab. Plain words ("收件箱").
12. A reload keeps the place and the unsent work: every page has an address, Back
    works, drafts survive in the tab.

**Faces and presence**

13. Icons over labels where the meaning is plain (`+`, inbox, search). Every avatar
    is round, people and agents alike; a person shows their Feishu picture, and an
    agent may have one.
14. Presence reads the same for everyone: "● 在线 / ○ 离线" under a face, a dot
    beside a name in a list. The team is a gallery of faces; adding is a tile in it.

**Input**

15. Hints live in placeholders. Fields typed in place look like the text they become:
    no box, one underline that turns green, no focus halo. "完成标准" is written as a
    checklist (Enter starts the next row). Choosing a person shows their face, or an
    empty dashed one.

**Layout**

16. Alignment is exact and measured, not eyeballed: siblings on a row share size,
    padding and line height; content aligns to its anchor; shared edges are truly
    shared; icons are truly centred.
17. Position follows the eye; width follows the content. Every view starts on the
    gutter beside the navigation — never centred for symmetry, which leaves the
    space between the two to nothing. Prose keeps a 720 px measure; a conversation
    is up to 960 px, so a code block, a table or a diagram may use that; a page is
    720 px (an agent's wider); the board uses the whole width, in equal-height
    columns; the composer is on the conversation's edges. No dead areas.
18. Hierarchy and material express structure — grouping, layering, focus — never
    decoration. Depth comes from the elevation scale (see **Elevation and material**)
    and only where something truly sits on or over something else: a card on its
    column, the composer over the conversation, a popover over the page. The grey
    canvas holds only what iOS groups on it — the sidebar, a phone's Home list, the
    board's columns — and the white on it is the content itself (a list, a task card),
    never a frame around a section.
19. Order by importance: the decision waiting on you comes first; long lists (runs)
    come last. Views are tabs on the left; there is no page title above them.

**Process**

20. Redesigns may explore with Google Stitch; these principles filter what it
    proposes, so leave out what the generator invents (step numbers, counts, shortcut
    hints, navigation repeated in the page).
21. Verify UI in a real browser: screenshot it and measure the boxes.

## Color

Values live in [web/style.css](../../web/style.css) (`:root`, redefined for dark mode);
it is the authority. Use the custom property for its role, never a raw colour.

The palette is iOS's, light and dark, following `prefers-color-scheme`:

| Token                                         | Light / dark                     | Role                                                                           |
| --------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------ |
| `--canvas`                                    | #F2F2F7 / #000000                | Grouped background: sidebar, phone Home, board columns, sign-in                |
| `--paper`                                     | #FFFFFF / #1C1C1E                | Content: the main column, lists and cards on the canvas                        |
| `--surface`, `--raised`                       | #FFF, #F7F7F9 / #2C2C2E          | Popovers and controls; a hovered row, a table's head                           |
| `--fill`, `--sunken`, `--hover`, `--selected` | grey at 12% / 24%                | Fields, segmented track, grey buttons; code; a current row; the chosen segment |
| `--ink`, `--ink-muted`, `--ink-subtle`        | #1C1C1E, #6C6C70 / #FFF, #98989F | Primary and secondary text; tertiary (#8E8E93) for glyphs only, never text     |
| `--hairline`, `--hairline-strong`             | #E5E5EA, #D1D1D6 / #38383A       | Separators, 0.5 px on a 2x screen (`--hairline-width`); control edges          |
| `--primary` (+ `-hover`, `-soft`), `--focus`  | #1D7A4F / #3FC587                | Primary actions, the current tab, links, focus                                 |
| `--human`, `--agent` (+ `-soft`, `-text`)     | ochre, indigo                    | Identity colour of people and agents (avatar grounds)                          |
| `--decision` (+ `-soft`, `-text`), `--badge`  | orange                           | The decision waiting on you, the Inbox; used sparingly                         |
| `--danger`, `--ok`, `--warn` (+ `-soft`)      | system red, green, amber         | A problem; done; offline or stale                                              |
| `--s-<status>`                                | one hue per status               | Task status dot and its stage column; 待验收 is orange                         |
| `--tint-<hue>` (+ `-text`)                    | six soft pastels                 | Channel icons                                                                  |

Every text colour reaches 4.5:1 on the surface it sits on, light and dark: secondary
text is at least 4.69:1 on the grey canvas, the green 5.32:1 as text and under white
button text.

## Typography

- One face, the system's: `-apple-system, BlinkMacSystemFont, "SF Pro Text",
"PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", system-ui, sans-serif`.
  Headings 600–700 with slight negative tracking; no serif, no uppercase labels.
- Monospace (the system's `ui-monospace` / SF Mono) only for code and identifiers
  (T3 references, IDs); times and labels are set in the UI face. Times, dates and
  numbers use tabular figures.
- The scale, on a 16 px root (`--text-body`, `--text-ui`, `--text-small`): what is
  read — messages, a task's text — 16 px on a wide screen and 17 px on a phone;
  controls, sidebar rows, names and fields 15 px (fields 16 px on a phone); secondary
  text (times, where, presence, section labels, the day) 12–13 px in `--ink-muted`.
- The team name: the UI face, 700, 18 px (15 px when long). On a phone's Home it is
  small and muted above the large title.
- A phone's Home has an iOS large title, "频道", 34 px bold.

## Shape and spacing

- Radius: 10 px fields, buttons and cards; 12 px lists, board columns and popovers;
  22 px the composer; 999 px pills; channel icons a rounded square (26% of their
  size); 50% for every avatar.
- Borders: hairline separators (0.5 px on a 2x screen, otherwise 1 px). Fields are
  filled grey with no border until focused (then green).
- Bars: a sticky header and a phone's bars are translucent, blurring what scrolls
  under them (`--material`, `--blur`: `saturate(180%) blur(20px)`), over a hairline;
  never an opaque slab. They run edge to edge across the content.
- Spacing scale: 4, 8, 12, 16, 24, 32, 48. Targets are generous: sidebar rows 40 px,
  header controls 38 px, a finger's 44 px on touch.

## Layout

- **Columns**: every view starts on the main area's gutter, beside the navigation.
  A conversation and its composer are one column of `--conversation` (960 px), its
  prose held to `--reading` (720 px) while code, tables and diagrams may use the
  rest; a page (a task, the Inbox, a settings section) is one column of
  `--reading`; all are fluid below it. An agent's page, which has a side column, is
  at most 72rem. The board takes the whole width.
- **Top bar**: the views' segmented control on the content's left edge (after the
  sidebar icon when the sidebar is closed), 38 px tall, 12 px above and below; its
  right end holds only "正在刷新…" when a refresh is slow.

## Elevation and material

Three levels, as tokens (`--elev-1`…`--elev-3`), each with a dark equivalent where
depth is a lighter surface and a faint top rim of light:

| Level | Token      | What sits there                                                    |
| ----- | ---------- | ------------------------------------------------------------------ |
| 1     | `--elev-1` | Rests on its surface: a task card, an image in a message           |
| 2     | `--elev-2` | Floats over content: the composer, a message's hover action        |
| 3     | `--elev-3` | Above everything: popovers, the search results, a floating sidebar |

Material (`--material`, `--material-strong`) is translucent paper or surface with the
blur, used by what floats or stays put while content scrolls under it: the bars, the
composer, the mention popover. The sidebar is set apart from the content by tone (the
grey canvas beside white), its hairline only finishing the edge. A card pointed at
lifts to its hover level and 1 px up.

## Icons

One maintained set, Lucide (`lucide-react`, pinned), wrapped in
[web/icons.tsx](../../web/icons.tsx) so every icon is drawn the same way: in the text
colour, a 1.5 px non-scaling stroke, at 16 px inline, 20 px in bars and headers, 24 px
for a phone's tabs and large marks. Icons are decorative; the control carries the
accessible name.

## Scrollbars

Thin overlays: the page's always (the system hides it when idle), a panel's (the
sidebar, the board, a code block, a table, search results) only while the pointer is
over it, using the standard `scrollbar-width` / `scrollbar-color` with a WebKit
fallback.

## Components

- **Avatar**: round for everyone; a picture when there is one (a person's from
  Feishu, an agent's set on its page), otherwise the initial on a soft ground of the
  identity colour (ochre for people, indigo for agents) inside a hairline ring of it.
- **Channel icon**: a channel's face, in sidebar rows, phone Home rows and search
  results: a rounded square in one of six soft tints, picked from the channel's ID
  so it never changes, with the first character of its name. It replaces the "#"
  (which stays for screen readers in search); 32 px in the sidebar and on a phone,
  24 px in search. Every name beside it — channels, topics and people — starts
  on one edge, and people's faces in the sidebar are the icon's size.
- **Segmented control**: the views (聊天 | 看板 | 团队 | 收件箱) and a narrow board's
  stages: a grey track, the chosen segment a raised white (dark: grey) thumb that
  eases in. In the top bar it is the page's primary control: 38 px tall, 15 px labels.
- **Menu**: what pops over the page from the control that opens it (Radix
  DropdownMenu): a white surface at the third elevation, rounded 12 px, rows of 36 px
  with a 16 px icon in the muted ink and the words, a shortcut or tick at the end in
  the muted ink, hairline separators between groups, a danger row in the danger
  colour. A pointer or the arrow keys light a row with the hover fill; Esc or a
  click elsewhere closes it, focus returning to what opened it.
- **Hour picker**: an hour of the day chosen in place, written as the time
  ("09:00") in tabular figures on one hairline underline that turns the primary
  colour under the pointer or focus, no box; the list is the browser's own.
- **Buttons**: primary is filled green; secondary a grey fill; destructive red text
  on the grey fill; a quiet one has no fill until hovered. Pressed, a control darkens
  its fill (lighter in dark mode; a quiet one takes the hover fill) and gives to 0.97
  of its size, a card as a whole; a row, a tab and a link in a sentence only darken.
  iOS's grey tap box is never drawn. A disabled control fades; the pointer stays.
- **Names**: a person is their Feishu name everywhere they appear (messages, the
  sidebar, Team, tasks, the Inbox, mentions, delivery lines), said once and never
  beside their handle. Until their next sign-in brings a name, the handle stands in.
- **Presence**: "● 在线 / ○ 离线" under a face (Team), a dot beside a name
  (sidebar, mention list). A person is online while a session of theirs was used in
  the last 90 seconds (an open workspace keeps it so); an agent while a worker can
  wake it, so an agent nobody runs is offline before anyone asks it. Others see it
  change without reloading.
- **Message**: avatar, then a line of name (15 px, 600), time (12 px, muted) and,
  only in the whole channel ("全部"), the topic as a pill after a little more room;
  inside a topic there is no tag.
- **Message group**: one author's messages within five minutes of each other form a
  group: the face and name once, the rest under them on the same text edge, close
  together. A later message's time appears in the face's column while it is pointed
  at (or tapped), and is always read out with its author. A group ends when the
  author changes, after a five-minute gap, at a change of topic, at a new day, or at
  the "new since" line. Each day opens with its date, quiet and centred between
  hairlines ("今天", "昨天", "11月13日周四"). Delivery lines, Stop and **转为任务**
  work the same on every message of a group.
- **Rich content**: bodies render a safe Markdown subset (paragraphs, lists, quotes,
  headings, code, emphasis, tables, images, http(s) links opening in a new tab) as
  React elements, never as HTML. A fenced code block is one rounded block in the
  system monospace, never boxed line by line, and keeps its language. A `mermaid`
  block is drawn as its diagram: Mermaid loads only when a message holds one, at its
  strict security level, laid out by dagre (ELK is never loaded unless a diagram
  asks for it), themed from the tokens for light or dark, and the drawing is
  shown as an image, so it runs nothing; its space is kept and it fades in; one that
  can't be drawn stays its code, silently. A table has hairline rows, a heavier head
  and scrolls sideways inside the message when wide. An image from this site is
  rounded, at most the message's width, and opens its original; one from elsewhere is
  its link, since the page loads images only from here. Links stay text links: there
  are no previews, which would need the server to fetch other sites.
- **Mentions and replies**: a mention already written as `@Name` gets no second chip. An
  agent's reply shows the message it answers, unless it is the very next message,
  and carries a line only for an exception (failed, stopped, shortened); what ran it
  lives with the run on the agent's page. **转为任务** shows on hover, and on touch
  once the message is tapped. A mention chip is a soft green tag.
- **Conversation**: opens at the newest message and stays at the bottom as messages
  arrive while you are there (and after you send); scrolled up, nothing moves under
  you. Scrolling up reads older messages in place; there are no page buttons. A "_time_ 以来的新消息"
  line marks what others wrote while the channel or topic was open.
- **Delivery line**: under a message that mentions an agent, and on a task handed to
  one, one line per agent in plain words, the agent's name first. A new state
  cross-fades over the old words; while the agent works a slow light passes over
  them (no spinner): 会接手 (will pick this up),
  离线，还没人接手 (offline), 正在处理 (working on it), 正在等待 T3 中的批准 (linking the run in
  T3, where it is approved), "T3 重新连接后 _Ada_ 会继续", 已回复（用时 3 分钟） (linking the
  reply; no line when the reply is the very next message), 卡住了 (what was lost and the
  one fix — re-enable the agent, add it back or open its setup — next to a retry), or
  一直没有接手. Between Chinese words there are no spaces ("小助手正在处理"); a Latin name
  keeps one ("Ada 正在处理"). The
  machine state is only a tooltip. Until it is answered a line ends in **停止**
  (also beside the request on the agent's page); then it reads "_Ada_ 正在停止" until
  the run's stopped reply ("还没回复就停止了。") arrives, or "_Ada_ 开始前已停止" when
  nothing had reached T3. A line stuck because _Ada_'s T3 access changed also ends in
  **停止**, which ends it at once: "_Ada_ 的 T3 权限变了，已停止".
- **Composer**: multi-line input with the `@` mention popover (the channel's agents
  and other people, found by a word of their name or a person's handle; a choice is
  written as @Name), floating on the bottom edge of
  the reading column, over a band of the page that fades the conversation out behind
  it. It is one large rounded field of translucent material at the second elevation,
  a single line until more is written, with "@" and Send sharing its centre; focus
  draws a soft green ring. Hints live in the placeholder. Send is the round green
  confirm button with an upward arrow, drawn larger here, growing in once there is
  something to send. A channel or topic that opens is ready to
  type in (a touch keyboard waits to be asked for), and sending keeps the keyboard.
  Sending never waits: the field empties at once, ready for the next message, and
  the message appears at the end of the conversation, grouped as it will be and
  faded until the server has it; then it comes to full strength in the same place.
  Messages go in the order written. One that didn't go stays where it is, faded,
  with a line like a delivery line: "没发出去", **重试** (sent again as the same
  operation, so it is posted once whatever happened) and **删除**. One still
  unconfirmed survives a reload or a change of channel, offering **重试**, unless
  it arrives on its own. While sending is paused (see **Out of reach**) nothing
  is sent and the text stays in the field.
- **Attaching**: a file pasted into the composer, dropped on it (the field draws a
  2 px green ring while one is held over it) or chosen with the paperclip beside "@"
  uploads at once and shows above the text: an image as a 56 px square of itself, any
  other file as a tile of its name and size. Each has a small round × at its corner
  to take it off. A file still uploading reads at half strength; one that can't be
  attached has a red outline and says why in its tile ("超过 25 MB",
  "团队的文件空间已满"). Send waits for every file to be there, and files alone are
  enough to send. At most ten go with one message; more are left out.
- **Files in a message**: under its text (or alone), images as they are, at most 240
  px tall and 360 px wide, rounded with a hairline, each holding its place before it
  loads and opening on its own when clicked; other files as a 360 px row of a file
  icon, the name and its size (2.4 MB) that downloads it. A file someone removed
  leaves a line in the secondary size and muted ink where it was: "_Grace_
  删除了一个文件 · 11月17日 14:02"; the text stays as written.
  The placeholder never repeats the channel: "输入 @ 提及成员，⌘/Ctrl+Enter 发送"
  ("输入 @ 提及成员" on a phone).
- **Channels**: the sidebar lists joined channels; a channel you left can be rejoined
  by name. A name too long for its row fades out at the row's edge and is said in full
  on hover. A channel someone else wrote in since you last read it has its name in
  semibold (the others medium); it reads as read once its newest message has been
  on screen in a visible tab, on any device (in a topic, as far as what is new is in
  that topic). There are no unread counts. Where the browser shows an app badge, it
  says whether anything is unread. Each channel is as loud as you set it from its
  row's **Menu** (right-click, or a long press on a phone): 与我有关 (the default),
  每条消息 or 静音, ticked, then 退出 #_name_ in the danger colour. A channel you muted
  is never unread and its name is in the muted ink; one you follow ends in a small
  bell in the subtle ink. A channel where something waits on you ends in a
  decision-coloured dot, the
  size of a presence dot and on its edge; it fades out once nothing waits there. The current channel holds its topics under
  it like a tree on a hairline trunk: "全部", the ten most recently active, "更多话题"
  for the rest, and a `+` that starts one. The current place carries the
  quiet hover fill, never a card: the channel, or the topic when one is open (its
  channel then keeps only ink); "全部" is never highlighted. The tree's trunk hangs
  from the channel icon's centre, and topics start on the channel names' edge. A topic is highlighted
  only while its channel's chat or board is the current place. Leaving is **退出 #_name_** in search; on a phone the topics are pills
  above the conversation, and "退出频道" waits where the conversation begins. A channel
  or topic just created is opened.
- **Board**: five stage columns, the stages of the lifecycle: 待开始 (proposed) →
  进行中 (working) → 审核中 (review) → 待验收 (human sign-off) → 已完成 (done). Rework
  stays in 进行中 (marked "已退回"); cancelled work goes to 已完成 (marked "已取消",
  hidden until asked for). Columns are rounded panels of the grey canvas sharing the width (the
  board never scrolls sideways), one equal height down to the view's bottom gutter, each headed by a coloured dot and its name
  (the dot on the cards' text edge) with a bar of that colour under it in the bottom gutter (together, the lifecycle along the board's foot), no counts; 待验收 stands out with an orange edge
  and a warm tint while it holds a card. A card's column is its status. A card is white and rounded: its
  title, then one line — what it asks of you — beside its owner/reviewer faces; a
  decision or rework is marked by an orange or red rule on its left. A new task
  starts from the dashed `+` card at the end of 待开始. Below 1024 px the stages are a
  segmented control.
- **Task page** (new or existing, one layout): lifecycle bar — passed steps neutral
  grey, the current one in its board column's colour, what is ahead a hairline; large
  title; the description, unless it only repeats the title; on the left, in order of
  importance, the decision waiting on you (orange rule) only when one does, then where
  the task is now (its delivery lines, a reply linking to it in the chat, or
  "任务已关闭。"), "完成标准" as a checklist, history as one timeline with faces, and
  last one quiet row of what else you may do; on the right owner, reviewer, acceptor
  and the topic. A new task's acceptor is a picker of the channel's people, starting at
  you; whoever it names decides.
- **Decision**: waits on you when you accept, review, claim, or own work sent back:
  the latest note that led here, the note typed in place ("写下备注", one underline that
  turns green) and the actions as buttons, the way forward green. The rest — 发布进展,
  请求审核, 转交工作, 退回修改, then 取消任务, the only red — are quiet buttons with no
  ellipsis; choosing one opens its note (and, to hand on, who to) in place of the row,
  with **返回**. Disabled with a reason only when offline.
- **History**: one sentence per event, each person by name, you included
  ("_Ada_ 验收通过：“…”"). A linked T3 run is said once, its sentence the link to the
  thread on the team's T3 (plain when there is none); its IDs never show. A read that
  fails retries by itself, a little later each time, and says "暂时读不到记录。" only
  once it keeps failing; it reads again whenever the task changes.
- **Agent page**: status card with its actions, requests in this channel, About
  (every fact visible, picture to change, Team MCP credential), runs as a table at the
  bottom, one T3 reference per run (its thread; the run on hover). A run shows what the agent last reported apart from what T3 confirms on
  **在 T3 中查看**; **在 T3 中打开** appears only when T3 supplied the link.
- **Agent setup**: one next step at a time. First **连接 T3**, once per team: a T3
  on this machine is found on its own, otherwise paste its MCP URL; approve in T3,
  choosing how agents may run (监督、自动或完全访问: supervised, auto or full access). When the workspace is reached over HTTPS, T3's approval ends on a
  page that does not load; its address goes into **批准后的地址** and
  **完成** completes the connection. The pairing-code hint names the T3 being
  connected. A read-only approval shows as the next step, never as success, and
  so does a sign-in that ended ("T3 的登录已到期") when nothing else lets agents
  run. Wherever the T3 is named, the mode agents' runs use follows it, in the words
  setup offers ("监督", "自动", "完全访问"). When the deployment connects T3 there is no
  first step (until it has connected, the step reads "正在连接 T3…"), and
  **重新连接** is how a person signs in to that T3 for a broader mode.
  Then choose what the agent runs on from one list of every provider's models. After
  that a single line says the agent is ready (or its worker is starting), with
  **更换模型**, **重新连接** and **断开连接**, and offers to add the agent to
  the channel on screen when it isn't in it. **自己运行工作进程** opens a page
  for operators: runtime preferences, the worker credential (issue, rotate, revoke),
  the `npm run t3:auth` step and an `inbox.json` binding without secrets.
- **Credential once**: a newly issued token appears once, with copy and download,
  and is gone when dismissed.
- **Team**: a gallery of faces with names and presence — you (a tile like everyone's;
  what is about you is your mark at the foot of the sidebar), the other people, then the agents; the last tile adds an agent. Faces are
  56 px in tiles of at least 7rem, as many to a row as fit; the add tile is simply the
  next cell. Someone who isn't in the open
  channel, person or agent, carries **加入 #_channel_** on their tile (their name is
  already under the face), on one line; a long channel name ends in an ellipsis.
- **People in the sidebar**: the other people in the channel, then its agents; you
  are not listed, since you know you are here. Someone else has no page: their row is their face, name
  and presence, sized and aligned exactly like a row that opens. Owner and reviewer
  pickers list the people in the channel as well as its agents, and a message shows
  its author's name.
- **Inbox**: the tab after Team, with how many things wait on you. Everything across
  the team waiting on you, one list, newest first: tasks for your sign-off, review or
  rework; stuck deliveries you caused; agents with queued work and no worker; and,
  first, a person's T3 sign-in from a week before it ends ("T3 的登录将于11月23日周一到期",
  then "T3 的登录已到期，智能体在等待" with a red rule, or "T3 的登录已到期，智能体改为以监督模式运行"
  without one while the deployment's session carries on) with **重新连接 T3** under it,
  the same sign-in as **连接 T3**; the deployment's own session never asks. A row is a face, what it is, where and when, an orange or red rule for a
  decision or a problem; the row opens where it is resolved (task, channel or agent),
  or holds the fix under it.
  A row leaves when its cause is resolved; there is nothing to dismiss. Expired
  deliveries are not listed; they stay on their message's delivery line.
- **Your mark and your menu**: at the foot of the sidebar, a row like a person's —
  your **mark** (your initials, the last two characters of a Chinese name, on the
  primary colour, round, 32 px; never your picture) and your name. A small moon on
  the mark's edge says you are in quiet time (paused, or outside your hours). It opens your menu (a
  **Menu**, above it): your mark, name and team; the state of notifications ("通知已开",
  "通知暂停到 08:00", "通知时段外，09:00 恢复") and, one choice away, 暂停 1 小时 / 暂停到明早 or
  恢复通知; 跟随系统 / 浅色 / 深色, ticked, which stays open to show it; 个人资料; 设置 ⌘,;
  then 退出登录 and 在所有设备上退出登录 in the danger colour.
- **Team menu**: the team's name at the head of the sidebar opens it: 成员, 智能体, 连接
  and 团队设置. Later, switching teams belongs here.
- **Settings**: a mode, not a page. ⌘, or either menu opens it on a section, and
  the sidebar becomes the settings map: ‹ 设置 where the team's name was (‹ or Esc
  returns to where you were), then 个人 — 通知, 我的助理, 外观, 个人资料, 账户与设备, 快捷键
  — and 团队 — 成员, 频道, 智能体, 规则, 连接, 集成, 文件与存储, 用量与成本, 审计记录,
  数据与导出 — each a row with its icon, the current one lit as a channel is, the
  planned ones after the working ones in each group; the map scrolls by itself, so
  your row at the foot never covers a section. The channel's views are not shown. The section opens in
  the main area on the gutter, with no title (the map says where you are) and
  nothing above it (the bar a channel's views sit in is bare here), a form's width;
  each has its address (`?settings=<id>`). A section is **groups**, 32 px apart,
  its first heading centred on the map's 设置 row: each under a 13 px semibold
  heading in the muted ink (none when the section is one group), its rows divided
  by hairlines. A **row** is its label (15 px, 500) and its value or control ending on the
  column's right edge, the hairline carrying the eye across. A **state** sits
  beside what it is about as a soft pill in the secondary size: green with a dot
  when it is on (这台设备 ● 已开启, 此浏览器 ● 正在使用, 来自飞书), grey otherwise (a
  channel's 关注 or 静音). A **list row** (a person, a channel, an
  agent, a file) is 56 px: a 32–40 px face or mark, the name over what to know in
  the secondary size and muted ink, and what can be done at the end; it opens its
  place. Signing out is the last group, 退出, its rows in the danger colour. A **planned section**
  (我的助理, 规则, 集成, 用量与成本, 审计记录, 数据与导出) is in the subtle ink
  in the map and opens as what it will hold: 规划中, then its rows in the subtle
  ink, each with a quiet rounded bar where its value will be, and no controls —
  never a loading state. 个人资料 is read-only, as
  Feishu gives it: your picture and name with the 来自飞书 pill, then 账号 (用户名,
  邮箱, 团队); 账户与设备 lists your sessions ("此浏览器 · 正在使用", or when one
  signed in and was last used, with **退出**) and the browsers receiving
  notifications (**移除**), then 退出; 成员, 频道 and 智能体 are list rows, a channel or
  an agent opening its place, and channels you left are their own group; 连接
  shows T3 and tries the Feishu bot (**给我发一条测试消息**), and, where the deployment can
  mint one, 配对码: **生成配对码** shows the code in 20 px semibold with "14:14 前有效"
  beside it and **在 T3 中配对**, ending on the column's edge under its row, gone once
  it has expired; **换一个**
  replaces it; 文件与存储 lists the files of
  every channel you are in, newest first, each a 40 px square of the picture (or a
  file mark), its name, and "who · #channel · when · size" in the secondary size;
  the row opens its message, and **删除** at its end becomes a red **确认删除** for a
  second press (leaving the button takes it back). On a phone, 我 opens the
  map as two iOS inset lists on the grey canvas (subtle ink for planned ones), and a
  section opens under a bar naming it, which leads back to the map.
- **通知** (the section): what may interrupt you is Kinmesh's rule (what concerns
  you, in channels you haven't muted; every message only where you follow), so
  nothing here lists kinds. Three groups: 送达 (where it reaches you), 免打扰 (when
  you're left alone) and, when there are any, 调整过的频道. "这台设备" says where this browser stands — **开启**; or **发送测试通知** (which reads
  "已发送" for a moment) and **停止接收** once on; or, in the muted ink, why it can't
  be ("浏览器拦截了通知，可在网站设置中允许", "添加到主屏幕后可以接收通知" on an iPhone not
  opened from its Home Screen, "这个浏览器收不到通知"). "转发到飞书": 立即 | 10 分钟后
  | 不用, what it does on hover. When you're left alone: "通知时段": 全天 | 自定; 自定
  adds a row under it, ending on the same edge, the two hours chosen in place ("09:00 –
  21:00", this browser's time zone) and 每天 | 工作日 after them. "暂停通知": 不暂停 | 1 小时 | 到明早
  (the next 8:00), the pause in force chosen and its end on hover; it ends by
  itself. Then 调整过的频道, list rows of a channel's icon, its name over its level,
  **恢复默认** at the end. Signing out, in 账户与设备, is that section's last group,
  退出: **退出登录** and **在所有设备上退出登录**, rows in the danger colour.
- **Feishu card**: what reaches you in Feishu is a card from the app's bot: the
  title in a green header, the line as plain text, and **查看** (the primary button)
  to open its place. Once it is settled the same card turns grey and the button
  says **已处理**, still opening the place. A summary after quiet time is a card too
  ("免打扰期间有 3 件事等你").
- **Notice**: while you are in Kinmesh, what would have notified you comes as a
  notice at the foot of the screen instead — the same title and line, in the toast's
  dark, for eight seconds — and a click opens its place.
- **Notifications**: one per place, the latest replacing the one before. The title
  is who wrote and where ("小助手 · #general · 话题"), or what waits on you and
  where ("等你验收", "请你评审", "退回给你", "交给你了", "_Ada_ 卡住了"); the line is the
  message, the task's title, or what the stuck agent was asked, on one line.
  Clicking one opens its place, in an open workspace if there is one. Once read or
  settled, the workspace closes what it showed in that browser. Kinmesh can be added
  to a phone's Home Screen (its icon is the brand mark), where iOS allows them.
- **Team name**: the organization's name as Feishu gives it, never typed here, heads
  the sidebar in bold — the button that opens the **Team menu** — no logo or avatar — sharing its row with search
  and, beside the content, the control that closes the sidebar. One line; a name of more
  than 12 characters is set smaller and wraps onto a second line, cut there with an
  ellipsis, its full name on hover. Its text starts on the headings' edge.
- **Sign in**: on the grey canvas, the brand and the team's promise beside one white
  card, **欢迎** and a single **使用飞书登录** button (a link drawn as the primary
  button). When
  Feishu sends someone back unsigned, the card says why in one line — not part of
  this organization, took too long, or Feishu couldn't be reached — and the reason
  leaves the address, so a reload starts clean. Turning back at Feishu returns here
  silently.
- **Sign out**: in your menu and in 账户与设备; nothing in the top bar.
- **Opening the workspace**: quiet. A load that is quick shows nothing; one that takes
  more than 0.6 s fades in the brand, "正在打开工作区…" and a skeleton board
  (at once without motion). Only a failure says "工作区打不开" and offers
  **再试一次**. An address that can't be opened is not a failure: a channel you are
  not in opens the default channel, a topic that isn't there opens its channel, a task
  that isn't there opens the board, each without a word.
- **Search** (the command palette): a magnifier in the team name's row, with no
  shortcut badge (on a phone, its own tab; see **Phone**). It or ⌘K / Ctrl+K turns
  the row into a field grown from the magnifier (the name hides), and the results
  hang below it, wider than the sidebar; Esc, a click elsewhere or a choice folds it
  back to the name. A closed sidebar opens to hold it. It jumps to
  views, channels, tasks and agents, and holds the actions that have no place on
  screen: **新任务**, **静音 #_name_** (**取消静音 #_name_** once muted), **每条消息都通知
  #_name_** (**只通知与我有关的 #_name_** once followed), **退出 #_name_** and
  **立即刷新**. Places come before actions,
  so a channel's name finds the channel first, not an action that mentions it.
- **Sidebar**: beside the content on every screen wider than a phone, open or closed
  from one control, the sidebar icon (**展开侧栏** / **收起侧栏**). Closed, the icon
  starts the header, its glyph on the content's edge and centred with the tabs, and
  the content takes the whole width. Open, the same icon ends the team name's row,
  after search: its glyph on the channels' `+` edge, centred with the magnifier and a
  finger's 44 px after it; while searching the field takes the whole row and the icon
  steps aside. From 900 px an open sidebar is a column beside the content. Narrower,
  it floats over the content's edge — inset 0.5 rem from the window, rounded, at the
  third elevation, at its usual width, nothing dimmed, the header under it unmoved — and closes
  again on a choice of place, a click or tap outside, or Esc. Nothing opens it on its
  own: no hover, no edge. `⌘\` / `Ctrl+\` opens and closes it; ⌘K opens it with search.
  From 900 px it starts open and each device remembers whether it was left open;
  narrower it always starts closed. This is navigation, not content, so it is the one
  overlay Principles 7–8 allow: an upright tablet cannot spare a column for it.
- **Refreshing**: absent while healthy. A refresh asked for (**立即刷新** in
  search) or a slow one shows a dot and "正在刷新…".
- **Out of reach**: one quiet line under the views — "连不上 Kinmesh。先显示之前的内容，恢复连接前暂停发送。"
  — with nothing to press:
  it comes back by itself.
- **Uncertain send**: when a request's outcome is unknown, the form keeps exactly what
  was sent and offers **重试同一操作**; nothing is resent on its own. A message
  instead stays in the conversation with **重试** (see **Composer**).

## Phone

Below 576 px the places stack instead of sitting side by side (from 576 px the
sidebar sits beside a content column of at least 360 px):

- **Home** (the 频道 tab) is the sidebar as an iOS grouped page: the team name small
  and muted, the large title "频道" with its `+`, then the channels as one inset white
  list on the grey canvas, the most recently written in first (by name among the
  silent ones). A row is the channel's icon, its name and the time of its newest
  message (the time today, otherwise the day), then "author：text" on one line — the
  text without its Markdown, cut with an ellipsis — and the waiting dot. While the
  channel is unread its name is semibold rather than medium, and the text and time
  are in ink rather than muted. Hairlines
  between rows start at the text. No channel is current
  here, and the team is not here: it is a view of each channel.
- **Opening**: an address with no place in it opens on 收件箱 when something waits on
  you, otherwise on Home; an address that names a place always opens there.
- **Bottom tabs**: icons only, each named for a screen reader — 频道 (`#`, Home), 搜索
  (the magnifier), 收件箱 (with how many things wait on you) and 我 (your mark) — four
  equal 44 px tabs with 24 px icons, the current one in the primary colour and a
  heavier stroke (your mark is already the primary colour), on a translucent bar. They sit under
  Home and the pages they open.
- **Search** is the 搜索 tab, a page at `?search` (⌘K on a keyboard): the field at
  the bottom, just above the keyboard (or the tabs, with none) and ready to type in,
  the results above it with the best match nearest the thumb — the same results,
  keys and actions as beside a sidebar. A choice goes there and leaves search; Esc or
  Back returns to where it was opened.
- **A channel** has the screen under a bar: back to Home, `# name`, then 聊天 | 看板 |
  团队 (the same gallery as on a wider screen, its add tile included).
  Its topics are pills above the conversation; there is no bottom bar.
- **Fingers and fields**: every target takes taps over 44 px, drawn no larger than it
  is; fields are 16 px, so nothing zooms.
- **A page** (agent, task, a worker you run) opens under its own bar: back, then what it
  is — the agent's name, or a task's channel since its title leads the page.
- **我** is the settings map (see **Settings**); 退出登录 is in 账户与设备.

## Tablet

From 576 to 1279 px the sidebar sits beside the content (see **Sidebar**: closed below 900 px,
open from there). On a touch screen (a coarse pointer, whatever the width) every target takes a
finger: sidebar rows, topics and the board's stage pills grow to 44 px; the header's
tabs and icons, the new-channel `+`, the sidebar icon and the magnifier keep their drawn
size and take 44 px of taps around it. A mouse keeps the compact sizes. The edges are
narrow so the content has the screen: 0.75 rem gutters beside and below the content, 0.5 rem inside
the sidebar, a header no taller than its tabs need. Touch has no Esc, so a page leads back
from a bar at its top-left; the sidebar already says where you are, so the bar holds
only the way back. A task has no bar: it sits on the board, and the 看板 tab lit above
it leads back. Held upright (below 1024 px) the board shows one stage at a time
and a page replaces the view. Held wide, an open task sits beside the board — one
stage, its card marked by a green edge — instead of replacing it.

## Motion

Short and purposeful: 100 ms (`--dur-press`) for a press; 150 ms (`--dur-fast`) for
hover and selection; 200 ms
(`--dur`) for what moves or appears — the segmented thumb, the composer's focus,
popovers, a new message, a card lifting, a page fading in where the view was — up to
320 ms for cards travelling between status columns and checklists drawing their ticks
on acceptance; ease-out or a gentle spring. With reduced motion nothing moves, slides
or scales; colour and fades that only say a state changed keep their short ease.

## Voice

The interface speaks Simplified Chinese (zh-CN): short, everyday words, one word per
concept (频道, 话题, 任务, 看板, 团队, 收件箱, 智能体, 成员), full-width punctuation, a
space only between Chinese and Latin text, dates and times formatted for zh-CN. This
document is in English and quotes the interface's own words.

Say what is true for the person, in their words: "Ada 正在等待 T3 中的批准", not what
the system disclaims ("Execution does not imply acceptance"). Every honesty
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
- History and status are sentences ("_Ada_ 验收通过：“…”"), never API verbs.
- An error never shows a status code. A refusal is one sentence where the person can
  act on it ("这个名称已被占用" under the field); what they can't act on isn't
  said.
