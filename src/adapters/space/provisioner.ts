import { z } from 'zod';

export const SpaceProvisioner = z.strictObject({
  endpoint: z.url({ protocol: /^https?$/ }).max(4096),
  tokenFile: z.string().min(1).max(4096),
});
export type SpaceProvisioner = z.infer<typeof SpaceProvisioner>;
