import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import type { Shared } from '../shared/share.js';
import { value } from '../shared/api.js';
import { ActionForm } from '../shared/action-form.js';
import { Field } from '../shared/field.js';
import { AttachIcon, SendIcon } from '../shared/icons.js';
import {
  inline,
  pendingOf,
  upload,
  type Pending,
} from '../shared/attachments.js';
import { fileSize } from '../../src/domain/attachments.js';
import { Avatar } from '../shared/avatar.js';
import { Presence } from '../shared/presence.js';
import { composing } from '../shared/keys.js';
import { keep, kept } from '../shared/session.js';

const mentionQuery = /(?:^|\s)@([\p{L}\p{N}\p{M}_.-]{0,40})$/u;
/** Someone the `@` popover offers: the channel's agents and other people. */
export interface Mentionable {
  kind: 'human' | 'agent';
  id: string;
  name: string;
  /** A person's handle, which finds them too; never shown. */
  handle: string | null;
  online: boolean;
}
/** Whether what follows `@` starts their name, a word of it, or their handle. */
function matches(member: Mentionable, query: string) {
  const typed = query.toLowerCase();
  return [member.name, ...member.name.split(/\s+/), member.handle ?? ''].some(
    (word) => word !== '' && word.toLowerCase().startsWith(typed),
  );
}
/**
 * Who a message mentions: everyone chosen from the `@` list, by their ID,
 * and whoever's `@Name` (or a person's `@handle`) is typed in full. Each `@`
 * names one member: the one chosen there, else the longest name that follows
 * it, so `@小助手 2 号` is never also `@小助手`.
 */
function mentionedIn(
  body: string,
  members: Mentionable[],
  chosen: Mentionable[],
) {
  const named = new Map<
    number,
    { member: Mentionable; length: number; chosen: boolean }
  >();
  const find = (member: Mentionable, said: string, picked: boolean) => {
    const found = new RegExp(
      '(?:^|\\s)@' +
        said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
        '(?![\\p{L}\\p{N}_-])',
      'giu',
    );
    for (const match of body.matchAll(found)) {
      const at = match.index + match[0].length - said.length;
      const kept = named.get(at);
      if (!kept || (!kept.chosen && (picked || said.length > kept.length)))
        named.set(at, { member, length: said.length, chosen: picked });
    }
  };
  for (const member of chosen) find(member, member.name, true);
  for (const member of members)
    for (const said of [member.name, member.handle])
      if (said !== null && said !== '') find(member, said, false);
  const mentioned = [...chosen];
  for (const { member } of named.values())
    if (!mentioned.some((m) => m.id === member.id)) mentioned.push(member);
  return mentioned;
}
export function Composer({
  channelPath,
  topicId,
  members,
  onSend,
  onDone,
  incoming,
  replyTo = null,
  onClearReply = () => undefined,
}: {
  channelPath: string;
  topicId: string;
  members: Mentionable[];
  /** The message this one answers, said above the field until sent or let go. */
  replyTo?: { id: string; said: string } | null;
  onClearReply?: () => void;
  /** What was shared to Kinmesh for this channel: attached, its text typed. */
  incoming?: { key: string; shared: Shared } | undefined;
  /** Takes a message on its way, so the field is free at once. */
  onSend: (path: string, body: Record<string, unknown>) => void;
  onDone: () => void;
}) {
  const [chips, setChips] = useState<Mentionable[]>([]);
  // Files dropped, pasted or chosen: each uploads in turn, and the message
  // goes once they all have.
  const [files, setFiles] = useState<Pending[]>([]);
  const [dragging, setDragging] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  // Files go up one at a time, in the order they were added, so a few large
  // ones never hold their bytes in the hub together.
  const queue = useRef<Promise<void>>(Promise.resolve());
  const going = useRef(new Map<string, AbortController>());
  useEffect(() => {
    const running = going.current;
    return () => {
      for (const abort of running.values()) abort.abort();
    };
  }, []);
  function patch(key: string, change: Partial<Pending>) {
    setFiles((old) =>
      old.map((f) => (f.key === key ? { ...f, ...change } : f)),
    );
  }
  function send(pending: Pending) {
    const abort = new AbortController();
    going.current.set(pending.key, abort);
    queue.current = queue.current.then(async () => {
      if (abort.signal.aborted) return;
      patch(pending.key, { state: 'uploading' });
      try {
        const attachment = await upload(
          channelPath,
          pending,
          (progress) => {
            patch(pending.key, { progress });
          },
          abort.signal,
        );
        patch(pending.key, { state: 'ready', progress: 1, attachment });
      } catch (cause) {
        patch(pending.key, {
          state: 'failed',
          problem: cause instanceof Error ? cause.message : '没有传上去',
        });
      } finally {
        going.current.delete(pending.key);
      }
    });
  }
  function attach(list: Iterable<File>) {
    const added = pendingOf(list, files.length);
    if (added.length === 0) return;
    setFiles((old) => [...old, ...added]);
    for (const pending of added) if (pending.state === 'queued') send(pending);
    input.current?.focus();
  }
  function detach(key: string) {
    going.current.get(key)?.abort();
    setFiles((old) => old.filter((f) => f.key !== key));
  }
  // Shared to Kinmesh: its files attached and its text in the field, once.
  const placed = useRef<string | null>(null);
  useEffect(() => {
    if (!incoming || placed.current === incoming.key) return;
    placed.current = incoming.key;
    attach(incoming.shared.files);
    const el = input.current;
    if (el && incoming.shared.text !== '') {
      el.value = (el.value ? el.value + '\n' : '') + incoming.shared.text;
      keep(draftKey, el.value);
      setReady(true);
    }
  });
  const filesReady =
    files.length > 0 && files.every((f) => f.state === 'ready');
  const filesWaiting = files.some((f) => f.state !== 'ready');
  const [query, setQuery] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLTextAreaElement>(null);
  const listId = useId();
  const candidates =
    query === null ? [] : members.filter((m) => matches(m, query)).slice(0, 8);
  const open = candidates.length > 0;
  function track() {
    const el = input.current;
    if (!el) return;
    const match = mentionQuery.exec(el.value.slice(0, el.selectionStart));
    setQuery(match ? (match[1] ?? '') : null);
    setActive(0);
  }
  function choose(member: Mentionable) {
    const el = input.current;
    if (!el || query === null) return;
    const caret = el.selectionStart;
    el.setRangeText(
      '@' + member.name + ' ',
      caret - query.length - 1,
      caret,
      'end',
    );
    keep(draftKey, el.value);
    setReady(true);
    el.focus();
    setChips((old) =>
      old.some((c) => c.id === member.id) ? old : [...old, member].slice(0, 20),
    );
    setQuery(null);
  }
  // A channel or topic that opens is ready to type in. A touch keyboard
  // stays down until asked for, and typing elsewhere is never interrupted.
  useEffect(() => {
    if (!window.matchMedia('(hover: hover)').matches) return;
    if (document.activeElement?.matches('input, textarea, select')) return;
    input.current?.focus({ preventScroll: true });
  }, [topicId]);
  const narrow = window.matchMedia('(max-width: 575px)').matches;
  // What was typed and not sent survives a reload, per channel.
  const draftKey = 'message:' + channelPath;
  const unsent = kept(draftKey);
  // Send shows once there is something to send.
  const [ready, setReady] = useState(
    () => typeof unsent === 'string' && unsent.trim() !== '',
  );
  return (
    <div
      className="composer"
      data-dragging={dragging ? 'true' : undefined}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={(e) => {
        if (
          !(e.relatedTarget instanceof Node) ||
          !e.currentTarget.contains(e.relatedTarget)
        )
          setDragging(false);
      }}
      onDrop={(e) => {
        if (e.dataTransfer.files.length === 0) return;
        e.preventDefault();
        setDragging(false);
        attach(e.dataTransfer.files);
      }}
    >
      <ActionForm
        title="给团队发消息"
        path={channelPath + '/messages'}
        submit="发送消息"
        icon={<SendIcon size={20} />}
        ready={(ready || filesReady) && !filesWaiting}
        handOff={onSend}
        onDone={() => {
          // The field is free for the next message at once; what was sent
          // shows in the conversation until the server has it.
          if (input.current) input.current.value = '';
          setFiles([]);
          setChips([]);
          setQuery(null);
          setReady(false);
          keep(draftKey, null);
          onClearReply();
          onDone();
        }}
        build={(f) => {
          const body = value(f, 'body').trim();
          const attached = files.flatMap((p) =>
            p.attachment === null ? [] : [p.attachment],
          );
          if (body === '' && attached.length === 0)
            throw new Error('Nothing to send');
          const mentioned = mentionedIn(body, members, chips);
          return {
            body,
            topicId: topicId || null,
            mentions: mentioned
              .slice(0, 20)
              .map((m) => ({ kind: m.kind, id: z.uuid().parse(m.id) })),
            sourceMessageId: replyTo?.id ?? null,
            sourceEventId: null,
            attachments: attached,
          };
        }}
      >
        {replyTo && (
          <p className="composer-reply">
            <span>回复 {replyTo.said}</span>
            <button
              type="button"
              className="quiet"
              aria-label="不再回复这条消息"
              onClick={onClearReply}
            >
              ×
            </button>
          </p>
        )}
        {files.length > 0 && (
          <ul className="composer-files" aria-label="附件">
            {files.map((p) => (
              <li
                key={p.key}
                data-state={p.state}
                title={p.problem ?? undefined}
              >
                {p.image && p.state !== 'failed' ? (
                  // The server's copy, once it has it: the square holds
                  // its place until then.
                  p.attachment !== null && inline(p.attachment.type) ? (
                    <img
                      src={`${channelPath}/attachments/${p.attachment.id}`}
                      alt=""
                    />
                  ) : (
                    <span className="composer-image" />
                  )
                ) : (
                  <span className="composer-file">
                    <span className="file-name">{p.file.name}</span>
                    <span className="file-size">
                      {p.problem ?? fileSize(p.file.size)}
                    </span>
                  </span>
                )}
                {p.state === 'uploading' && (
                  <progress
                    className="composer-progress"
                    max={1}
                    value={p.progress}
                    aria-label={'上传 ' + p.file.name}
                  />
                )}
                <button
                  type="button"
                  className="composer-file-remove"
                  aria-label={'移除 ' + p.file.name}
                  onClick={() => {
                    detach(p.key);
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {chips.length > 0 && (
          <ul className="mention-chips" aria-label="提及">
            {chips.map((member) => (
              <li key={member.id}>
                <span className="mention-chip" data-kind={member.kind}>
                  @{member.name}
                </span>
                <button
                  type="button"
                  className="quiet"
                  aria-label={'移除对 ' + member.name + ' 的提及'}
                  onClick={() => {
                    setChips((old) => old.filter((c) => c.id !== member.id));
                    // The `@Name` written for them goes too, or the text
                    // would still mention them.
                    const el = input.current;
                    if (!el) return;
                    for (const said of [member.name, member.handle])
                      if (said)
                        el.value = el.value.replace(
                          new RegExp(
                            '(^|\\s)@' +
                              said.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') +
                              '(?![\\p{L}\\p{N}_-]) ?',
                            'giu',
                          ),
                          '$1',
                        );
                    keep(draftKey, el.value || null);
                    setReady(el.value.trim() !== '');
                  }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="composer-input">
          {open && (
            <ul
              className="mention-popover"
              id={listId}
              role="listbox"
              aria-label="可提及的成员"
            >
              {candidates.map((member, index) => (
                <li
                  key={member.id}
                  id={listId + '-' + member.id}
                  role="option"
                  aria-selected={index === active}
                  onMouseDown={(e) => {
                    e.preventDefault();
                    choose(member);
                  }}
                >
                  <Avatar
                    kind={member.kind}
                    name={member.name}
                    id={member.id}
                    size="sm"
                  />
                  <span className="person-name">{member.name}</span>
                  {/* Two of the same name are told apart by handle. */}
                  {member.handle !== null &&
                    candidates.some(
                      (other) =>
                        other.id !== member.id && other.name === member.name,
                    ) && <span className="muted">{member.handle}</span>}
                  <Presence online={member.online} dot />
                </li>
              ))}
            </ul>
          )}
          <Field label="消息">
            <textarea
              ref={input}
              name="body"
              rows={2}
              required={files.length === 0}
              maxLength={8000}
              role="combobox"
              aria-autocomplete="list"
              aria-expanded={open}
              aria-controls={open ? listId : undefined}
              aria-activedescendant={
                open && candidates[active]
                  ? listId + '-' + candidates[active].id
                  : undefined
              }
              // The hints belong in the placeholder; the sidebar already
              // names the channel, and a phone has no shortcut keys.
              placeholder={
                narrow
                  ? '输入 @ 提及成员'
                  : '输入 @ 提及成员，⌘/Ctrl+Enter 发送'
              }
              defaultValue={typeof unsent === 'string' ? unsent : ''}
              onInput={(e) => {
                keep(draftKey, e.currentTarget.value || null);
                setReady(e.currentTarget.value.trim() !== '');
                track();
              }}
              onClick={track}
              onPaste={(e) => {
                if (e.clipboardData.files.length === 0) return;
                e.preventDefault();
                attach(e.clipboardData.files);
              }}
              onBlur={() => {
                setQuery(null);
              }}
              onKeyDown={(e) => {
                if (composing(e)) return;
                if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
                  // The submit handler still refuses while sending is paused.
                  e.preventDefault();
                  e.currentTarget.form?.requestSubmit();
                  return;
                }
                if (!open) return;
                if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                  e.preventDefault();
                  const step = e.key === 'ArrowDown' ? 1 : -1;
                  setActive(
                    (old) =>
                      (old + step + candidates.length) % candidates.length,
                  );
                } else if (e.key === 'Enter' || e.key === 'Tab') {
                  const member = candidates[active];
                  if (member) {
                    e.preventDefault();
                    choose(member);
                  }
                } else if (e.key === 'Escape') {
                  e.preventDefault();
                  e.stopPropagation();
                  setQuery(null);
                }
              }}
            />
          </Field>
          <input
            ref={picker}
            type="file"
            multiple
            hidden
            onChange={(e) => {
              if (e.currentTarget.files) attach(e.currentTarget.files);
              e.currentTarget.value = '';
            }}
          />
          <button
            type="button"
            className="quiet composer-attach"
            aria-label="添加文件"
            onClick={() => picker.current?.click()}
          >
            <AttachIcon size={20} />
          </button>
          <button
            type="button"
            className="quiet mention-trigger"
            aria-label="提及成员"
            disabled={members.length === 0}
            onClick={() => {
              const el = input.current;
              if (!el) return;
              el.focus();
              const before = el.value.slice(0, el.selectionStart);
              el.setRangeText(
                before === '' || /\s$/.test(before) ? '@' : ' @',
                el.selectionStart,
                el.selectionEnd,
                'end',
              );
              track();
            }}
          >
            @
          </button>
        </div>
      </ActionForm>
    </div>
  );
}
