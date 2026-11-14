// Another process writing to the team's database, as the Inbox worker and
// Team MCP do: it opens its own store, posts once as a person and exits.
import { z } from 'zod';
import { openStore } from '../../src/persistence/store.js';
import { ChannelId, HumanId, TeamId } from '../../src/domain/contracts.js';
import { PostInput } from '../../src/domain/communication.js';

const [url, request] = process.argv.slice(2);
if (url === undefined || request === undefined)
  throw new Error('Missing fixture arguments');
const { humanId, teamId, channelId, input } = z
  .object({
    humanId: HumanId,
    teamId: TeamId,
    channelId: ChannelId,
    input: PostInput,
  })
  .parse(JSON.parse(request));
const store = await openStore(url);
try {
  await store.communication.post(
    { kind: 'human', humanId },
    teamId,
    channelId,
    input,
  );
} finally {
  await store.close();
}
