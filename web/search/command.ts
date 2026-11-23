export interface Command {
  id: string;
  group: string;
  label: string;
  hint?: string | undefined;
  /** A channel shows its icon in place of the "#" its label starts with. */
  channel?: { id: string; name: string };
  run: () => void;
}
/** Every word typed must appear somewhere in the label, hint or group. */
export function matches(command: Command, query: string) {
  const text = `${command.label} ${command.hint ?? ''} ${command.group}`
    .toLowerCase()
    .normalize('NFKD');
  return query
    .toLowerCase()
    .normalize('NFKD')
    .split(/\s+/)
    .filter(Boolean)
    .every((word) => text.includes(word));
}
/** Found on the hub for what is typed: messages and files, by their text. */
export type Remote = (query: string, signal: AbortSignal) => Promise<Command[]>;
