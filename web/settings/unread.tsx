import { Notice } from '../shared/notice.js';

/** A read that failed: said where it would have shown, with a retry. */
export function Unread({ what, retry }: { what: string; retry: () => void }) {
  return (
    <Notice>
      读不到{what}。
      <button type="button" className="link-button" onClick={retry}>
        再试一次
      </button>
    </Notice>
  );
}
