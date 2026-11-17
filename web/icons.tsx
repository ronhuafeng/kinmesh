import {
  ArrowRight,
  ArrowUp,
  Bell,
  Bot,
  ChartColumn,
  Check,
  ChevronLeft,
  CircleUserRound,
  Download,
  FolderOpen,
  Hash,
  Inbox,
  Keyboard,
  LogOut,
  MonitorSmartphone,
  Moon,
  PanelLeft,
  Plug,
  Plus,
  Power,
  Puzzle,
  Scale,
  ScrollText,
  Search,
  Settings,
  Sparkles,
  SunMoon,
  Users,
  type LucideIcon,
} from 'lucide-react';

/**
 * The one icon set (Lucide), drawn in the current text colour at one stroke
 * weight: 1.5 px on screen whatever the size (a non-scaling stroke), so a
 * 16, 20 or 24 px glyph reads alike.
 * Decorative; the control around it carries the accessible name.
 */
export type IconSize = 16 | 20 | 24;
function icon(Glyph: LucideIcon) {
  return function Icon({ size = 16 }: { size?: IconSize }) {
    return (
      <Glyph
        className="icon"
        size={size}
        strokeWidth={1.5}
        nonScalingStroke
        aria-hidden="true"
        focusable="false"
      />
    );
  };
}
export const SearchIcon = icon(Search);
export const InboxIcon = icon(Inbox);
/** Sign out: the power symbol. */
export const PowerIcon = icon(Power);
/** The sidebar: opens and closes it. */
export const SidebarIcon = icon(PanelLeft);
export const PlusIcon = icon(Plus);
/** Confirm: go ahead with what was typed. */
export const ArrowIcon = icon(ArrowRight);
/** Send a message: up, into the conversation. */
export const SendIcon = icon(ArrowUp);
/** Back to the place above, on a phone. */
export const BackIcon = icon(ChevronLeft);
/** A phone's channels tab: the channels and the team. */
export const HashIcon = icon(Hash);
/** Settings: what each section is, in the settings map and your menu. */
export const SettingsIcons = {
  bell: icon(Bell),
  bot: icon(Bot),
  chart: icon(ChartColumn),
  check: icon(Check),
  person: icon(CircleUserRound),
  download: icon(Download),
  folder: icon(FolderOpen),
  keyboard: icon(Keyboard),
  logOut: icon(LogOut),
  devices: icon(MonitorSmartphone),
  moon: icon(Moon),
  plug: icon(Plug),
  puzzle: icon(Puzzle),
  scale: icon(Scale),
  scroll: icon(ScrollText),
  settings: icon(Settings),
  sparkles: icon(Sparkles),
  appearance: icon(SunMoon),
  users: icon(Users),
  hash: icon(Hash),
};
