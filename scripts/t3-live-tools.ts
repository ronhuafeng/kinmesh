import { z } from 'zod';
import {
  EXECUTION_TOOLS,
  ToolList,
  ValidatedTools,
  type Wire,
} from '../src/adapters/t3/contracts.js';

/** Live harnesses also archive the threads they launch; the product never does. */
export const LIVE_TOOLS = [...EXECUTION_TOOLS, 't3_thread_organize'] as const;

// T3 0.1.5 lists organize without its union outputSchema. Archive returns its
// documented dispatch sequence, so validate exactly that.
const archived = z.toJSONSchema(
  z.object({ sequence: z.number().int().nonnegative() }),
  { target: 'draft-7' },
);

/** The execution tools plus organize, every one validated against its schema. */
export async function liveTools(wire: Wire) {
  const { tools } = ToolList.parse(await wire.list());
  return new ValidatedTools(
    wire,
    {
      tools: tools.map((tool) =>
        tool.name === 't3_thread_organize' && tool.outputSchema === undefined
          ? { ...tool, outputSchema: archived }
          : tool,
      ),
    },
    LIVE_TOOLS,
  );
}
