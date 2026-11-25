import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DomainError, type Refusal } from '../src/domain/errors.js';
import { Task, principalAuthor, TaskCommand } from '../src/domain/tasks.js';
import { key, postInput } from './communication-helpers.js';
import { taskFixture, commandInput } from './task-helpers.js';

type Proof = NonNullable<
  Extract<TaskCommand, { type: 'request-review' }>['proof']
>;
const rejected = (kind: Refusal) => (e: unknown) =>
  e instanceof DomainError && e.kind === kind;

/**
 * Proves the owner's proof reaches whoever decides, as given and checked:
 * asking for review it cites, per criterion, its words and PRs and runs of
 * the task, messages of its channel and addresses; whoever reads the task
 * sees them under each criterion; anything not the task's or its channel's
 * refuses the whole request alike and changes nothing; a retry gives the
 * same round; the next request is a new round, and history keeps each.
 */
await test('the owner’s proof for each criterion is kept as given when it asks for review, and only the task’s own can be cited', async () => {
  const f = await taskFixture();
  try {
    let { task } = await f.create({
      owner: { kind: 'agent', id: f.agent.id },
      criteria: ['Tests pass', 'Deployed', 'Docs updated'],
    });
    task = (
      await f.act(f.developer, task, {
        type: 'link-pull-request',
        pullRequest: { repository: 'acme/widgets', number: 7 },
      })
    ).task;
    const run = await f.act(f.developer, task, {
      type: 'link-execution',
      reference: {
        backend: 't3',
        environmentId: 'environment',
        threadId: 'thread',
        runId: 'run',
      },
      note: 'The run that did it',
    });
    task = run.task;
    const executionId = run.executionLink?.id ?? '';
    const message = await f.store.messages.post(
      f.principal,
      f.teamId,
      f.channelId,
      postInput({ body: 'Deployed to staging' }),
    );
    const elsewhere = await f.store.channels.createChannel(
      f.principal,
      f.teamId,
      { operationKey: key(), name: 'Elsewhere' },
    );
    const hidden = await f.store.messages.post(
      f.principal,
      f.teamId,
      elsewhere.id,
      postInput({ body: 'Not this task’s' }),
    );
    const reviewer = { kind: 'agent', id: f.reviewer.id } as const;
    const ask = async (proof?: Proof) =>
      f.act(f.developer, task, {
        type: 'request-review',
        reviewer,
        note: 'Ready',
        proof,
      });

    // Nothing that is not the task's or its channel's: refused alike.
    for (const proof of [
      [
        {
          criterion: 0,
          pieces: [{ kind: 'message', messageId: hidden.id }],
        },
      ],
      [
        {
          criterion: 0,
          pieces: [
            {
              kind: 'pull-request',
              pullRequest: { repository: 'acme/widgets', number: 8 },
            },
          ],
        },
      ],
      [
        {
          criterion: 0,
          pieces: [{ kind: 'run', executionId: randomUUID() }],
        },
      ],
      [{ criterion: 3, words: 'No such criterion' }],
    ] as Proof[])
      await assert.rejects(() => ask(proof), rejected('invalid'));
    // An address is only https, and a criterion says something.
    await assert.rejects(() =>
      ask([
        {
          criterion: 0,
          pieces: [{ kind: 'link', url: 'http://example.com' }],
        },
      ]),
    );
    await assert.rejects(() => ask([{ criterion: 0 }]));
    // Work handed on carries no proof.
    await assert.rejects(
      () =>
        f.act(f.developer, task, {
          type: 'handoff',
          recipient: reviewer,
          mode: 'work',
          note: 'Yours',
          proof: [{ criterion: 0, words: 'Done' }],
        }),
      rejected('invalid'),
    );
    const unchanged = await f.tasks.get(
      f.principal,
      f.teamId,
      f.channelId,
      task.id,
    );
    assert.equal(unchanged.version, task.version);
    assert.equal(unchanged.proof, null);

    // The proof as given, kept with who gave it and when.
    const command = commandInput(task, {
      type: 'request-review',
      reviewer,
      note: 'Ready',
      proof: [
        {
          criterion: 0,
          words: 'CI passes on the PR',
          pieces: [
            {
              kind: 'pull-request',
              pullRequest: { repository: 'Acme/Widgets', number: 7 },
            },
            { kind: 'link', url: 'https://ci.example.com/build/12' },
          ],
        },
        {
          criterion: 1,
          pieces: [
            { kind: 'run', executionId },
            { kind: 'message', messageId: message.id },
          ],
        },
      ],
    });
    const asked = await f.tasks.command(
      f.developer,
      f.teamId,
      f.channelId,
      task.id,
      command,
    );
    const proof = asked.task.proof;
    assert.ok(proof);
    assert.deepEqual(proof.author, principalAuthor(f.developer));
    assert.deepEqual(proof.criteria, [
      {
        criterion: 'Tests pass',
        words: 'CI passes on the PR',
        pieces: [
          {
            kind: 'pull-request',
            pullRequest: { repository: 'Acme/Widgets', number: 7 },
          },
          { kind: 'link', url: 'https://ci.example.com/build/12' },
        ],
      },
      {
        criterion: 'Deployed',
        words: null,
        pieces: [
          {
            kind: 'run',
            executionId,
            reference: run.executionLink?.reference,
            linkedAt: run.executionLink?.createdAt,
          },
          {
            kind: 'message',
            messageId: message.id,
            author: message.author,
            sentAt: message.createdAt,
          },
        ],
      },
    ]);
    // A retry is the same round; the same key asking otherwise is refused.
    assert.deepEqual(
      await f.tasks.command(
        f.developer,
        f.teamId,
        f.channelId,
        task.id,
        command,
      ),
      asked,
    );
    await assert.rejects(
      () =>
        f.tasks.command(
          f.developer,
          f.teamId,
          f.channelId,
          task.id,
          TaskCommand.parse({
            ...command,
            proof: [{ criterion: 2, words: 'Other' }],
          }),
        ),
      rejected('conflict'),
    );
    // Whoever reads the task sees it, the reviewer over HTTP included.
    const read = await f.app.inject({
      url: `${f.taskPath}/${task.id}`,
      headers: f.reviewerHeaders,
    });
    assert.deepEqual(Task.parse(read.json()).proof, proof);

    // Sent back, it is still what was sent back; the next request is a new
    // round, and history keeps both.
    task = (
      await f.act(f.reviewPrincipal, asked.task, {
        type: 'review',
        decision: 'rework',
        note: 'Docs are missing',
      })
    ).task;
    assert.deepEqual(task.proof, proof);
    task = (await f.act(f.developer, task, { type: 'progress', note: 'Docs' }))
      .task;
    task = (
      await f.act(f.developer, task, {
        type: 'request-review',
        reviewer,
        note: 'Docs too',
        proof: [{ criterion: 2, words: 'README updated' }],
      })
    ).task;
    assert.deepEqual(
      task.proof?.criteria.map((c) => c.criterion),
      ['Docs updated'],
    );
    const rounds = (
      await f.tasks.history(f.principal, f.teamId, f.channelId, task.id)
    ).items
      .filter((e) => e.command.type === 'request-review')
      .map((e) => e.after.proof?.criteria.map((c) => c.criterion));
    assert.deepEqual(rounds, [['Tests pass', 'Deployed'], ['Docs updated']]);
  } finally {
    await f.dispose();
  }
});
