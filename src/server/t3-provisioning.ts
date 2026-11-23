import type { FastifyInstance } from 'fastify';
import type { Store } from '../persistence/store.js';
import { describeFailure } from '../diagnostics.js';
import type { Changes } from './changes.js';
import type { Config } from './config.js';
import type { Hub } from './connect.js';
import {
  endProvisionedT3,
  provisionedT3,
  separateDeploymentSession,
} from './provision.js';

/**
 * The deployment's own T3, when it has one: its session kept apart from a
 * person's, applied now and again every minute; without one, ended.
 */
export function startT3Provisioning(
  app: FastifyInstance,
  store: Store,
  hub: Hub,
  config: Config,
  changes: Changes,
) {
  try {
    separateDeploymentSession(hub.directory);
  } catch (error) {
    app.log.error(describeFailure(error), 't3_session_separation_failed');
  }
  // The deployment's T3: applied now, then whenever its session is renewed.
  if (config.t3) {
    const sync = provisionedT3(
      store,
      hub.directory,
      config.t3,
      fetch,
      hub.ceiling,
    );
    const run = () => {
      sync().then(
        (changed) => {
          if (changed) changes.emit();
        },
        (error: unknown) => {
          app.log.error(
            { error: error instanceof Error ? error.name : 'Error' },
            't3_provision_failed',
          );
        },
      );
    };
    run();
    const provisioning = setInterval(run, 60_000);
    provisioning.unref();
    app.addHook('onClose', () => {
      clearInterval(provisioning);
      return Promise.resolve();
    });
  } else
    try {
      // Only a person's sign-in runs now; the deployment's is not renewed.
      endProvisionedT3(hub.directory);
    } catch (error) {
      app.log.error(describeFailure(error), 't3_provision_end_failed');
    }
}
