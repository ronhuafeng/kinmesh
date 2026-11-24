import { useEffect, useState } from 'react';
import { z } from 'zod';
import { api } from '../shared/api.js';

/**
 * Where the agent's own Codex home is beside T3, which Kinmesh configures
 * when the agent is connected; null without a provisioner there.
 */
export function useCodexHome(teamId: string, agentId: string) {
  const [home, setHome] = useState<string | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    void api(`/api/teams/${teamId}/agents/${agentId}/codex`, {
      signal: controller.signal,
    })
      .then((raw) => {
        setHome(z.object({ home: z.string() }).parse(raw).home);
      })
      .catch(() => undefined);
    return () => {
      controller.abort();
    };
  }, [teamId, agentId]);
  return home;
}
