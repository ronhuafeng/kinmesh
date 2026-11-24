import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {
  TaskPullRequestView,
  type CommitChecks,
} from '../src/domain/pull-requests.js';
import { pullRequestWords } from '../web/tasks/model.js';

const sha = 'b'.repeat(40);
const now = Date.parse('2026-11-24T10:00:00.000Z');
const at = (minutesAgo: number) =>
  new Date(now - minutesAgo * 60_000).toISOString();
function link(observation: unknown) {
  return TaskPullRequestView.parse({
    id: randomUUID(),
    position: 1,
    taskId: randomUUID(),
    pullRequest: { repository: 'Acme/Widgets', number: 7 },
    author: { kind: 'human', humanId: randomUUID() },
    createdAt: at(30),
    observation,
  });
}
const observed = (
  over: Record<string, unknown>,
  checks: CommitChecks | null = null,
) => ({
  kind: 'observed',
  repository: 'Acme/Widgets',
  number: 7,
  title: 'Add the widget',
  state: 'open',
  draft: false,
  url: 'https://github.com/Acme/Widgets/pull/7',
  headRef: 'widget',
  headSha: sha,
  baseRef: 'main',
  checks,
  observedAt: at(1),
  ...over,
});
const checks = (
  state: 'passing' | 'failing' | 'pending' | 'none',
): CommitChecks => ({
  kind: 'observed',
  sha,
  state,
  passed: 0,
  failed: state === 'failing' ? 1 : 0,
  pending: 0,
  observedAt: at(1),
});

await test('a linked PR reads as GitHub said: its state, and its head commit’s checks', () => {
  // Before GitHub answers, nothing is said.
  assert.deepEqual(pullRequestWords(link(null), now), {
    state: null,
    checks: null,
    failing: false,
  });
  assert.equal(
    pullRequestWords(link(observed({ state: 'merged' })), now).state,
    '已合并',
  );
  assert.equal(
    pullRequestWords(link(observed({ draft: true })), now).state,
    '草稿',
  );
  for (const [state, words] of [
    ['passing', 'CI 通过'],
    ['failing', 'CI 失败'],
    ['pending', 'CI 进行中'],
    ['none', '没有 CI'],
  ] as const) {
    const said = pullRequestWords(link(observed({}, checks(state))), now);
    assert.equal(said.checks, words);
    // Only failing checks are marked.
    assert.equal(said.failing, state === 'failing');
  }
  assert.equal(
    pullRequestWords(
      link(
        observed(
          {},
          { kind: 'unavailable', sha, reason: 'forbidden', observedAt: at(1) },
        ),
      ),
      now,
    ).checks,
    '读不到 CI：没有权限',
  );
  // An old answer says so; checks read before Kinmesh read them say nothing.
  const old = pullRequestWords(link(observed({ observedAt: at(60) })), now);
  assert.equal(old.state, '进行中，可能已过时');
  assert.equal(old.checks, null);
  assert.equal(
    pullRequestWords(
      link({ kind: 'unavailable', reason: 'not-found', observedAt: at(1) }),
      now,
    ).state,
    'GitHub 上找不到，或没有权限查看',
  );
});
