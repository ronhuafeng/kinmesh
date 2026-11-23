/**
 * Online or offline, said the same way for people and agents: a person is
 * online while signed in here; an agent while a worker can wake it. In a
 * list the word is left to the dot (and to screen readers).
 */
export function Presence({
  online,
  dot = false,
}: {
  online: boolean;
  dot?: boolean;
}) {
  const word = online ? '在线' : '离线';
  return (
    <span
      className={dot ? 'presence dot' : 'presence'}
      data-online={online ? 'true' : undefined}
      {...(dot ? { title: word } : {})}
    >
      {dot ? <span className="visually-hidden">{word}</span> : word}
    </span>
  );
}
