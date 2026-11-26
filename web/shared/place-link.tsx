import type { ComponentProps } from 'react';

/**
 * A place is a link to its address. A plain click opens it here, in the
 * workspace; a modified one (⌘ or Ctrl, Shift, Alt) is the browser's, as is
 * the middle button (which never clicks): a new tab or window, the address
 * copied.
 */
export function PlaceLink({
  onOpen,
  onClick,
  ...props
}: ComponentProps<'a'> & { href: string; onOpen: () => void }) {
  return (
    <a
      {...props}
      onClick={(event) => {
        onClick?.(event);
        if (
          event.defaultPrevented ||
          event.button !== 0 ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          event.altKey
        )
          return;
        event.preventDefault();
        onOpen();
      }}
    />
  );
}
