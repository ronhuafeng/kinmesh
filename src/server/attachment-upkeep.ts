import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import type { AttachmentStore } from '../persistence/attachment-store.js';
import { spaceRemover } from '../adapters/space/client.js';
import type { SpaceProvisioner } from '../adapters/space/provisioner.js';
import { describeFailure } from '../diagnostics.js';
import { sweepAttachments, unplaceAttachments } from './attachments.js';

/**
 * Keeps the file store tidy while the hub runs: files never posted are
 * swept, and removed ones leave their channel's folder.
 */
export function startAttachmentUpkeep(
  app: FastifyInstance,
  store: Store,
  files: AttachmentStore,
  space: SpaceProvisioner | null,
) {
  const stopSweeping = sweepAttachments(store, files, (error) => {
    app.log.error(describeFailure(error), 'attachment_sweep_failed');
  });
  const stopUnplacing =
    space === null
      ? () => undefined
      : unplaceAttachments(store, spaceRemover(space), (error) => {
          app.log.error(describeFailure(error), 'attachment_unplace_failed');
        });
  app.addHook('onClose', () => {
    stopSweeping();
    stopUnplacing();
    return Promise.resolve();
  });
}
