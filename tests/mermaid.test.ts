import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describe } from '../web/mermaid.js';

/** An untitled diagram is named by what it shows, for a screen reader. */
await test('an untitled diagram is described by its first node names', () => {
  assert.equal(
    describe('flowchart LR\n  A["Proposed<br/>by Ada"] --> B[Done]'),
    'Proposed by Ada、Done',
  );
  assert.equal(
    describe(
      'flowchart TB\n  H["Host"]\n  D(Disc) --> C{Client}\n  F[(Feishu)] --> G[[Grant]]',
    ),
    'Host、Disc、Client、Feishu…',
  );
  // Nothing named: its kind.
  assert.equal(describe('sequenceDiagram\n  Ada->>Pi: hi'), 'sequenceDiagram');
});
