/**
 * Repository factory.
 *
 * Every repository is backed by the filesystem `FileStore`. Services depend on
 * this factory alone, so storage details never leak into business logic.
 */
import { createApiKeyRepository } from './apiKey.repository.js';
import { createInstanceRepository } from './instance.repository.js';
import { createAuditRepository, createWebhookEventRepository } from './event.repository.js';
import { createMessageRepository } from './message.repository.js';
import { createSessionRepository } from './session.repository.js';
import { createConnectionRepository } from './connection.repository.js';
import { createDeliveryRepository } from './delivery.repository.js';
import { createAutoReplyRepository } from './autoreply.repository.js';

export function createRepositories({ store, encryption = null, logger = null }) {
  const repositories = {
    mode: 'filesystem',
    apiKeys: createApiKeyRepository({ store, logger }),
    instances: createInstanceRepository({ store, logger }),
    audit: createAuditRepository({ store, logger }),
    webhookEvents: createWebhookEventRepository({ store, logger }),
    messages: createMessageRepository({ store, encryption, logger }),
    sessions: createSessionRepository({ store, logger }),
    connections: createConnectionRepository({ store, logger }),
    deliveries: createDeliveryRepository({ store, encryption, logger }),
    autoreplies: createAutoReplyRepository({ store, logger }),
  };

  /** Test helper: wipe every store. */
  repositories.resetAll = async () => {
    await Promise.all([
      repositories.apiKeys.reset(),
      repositories.instances.reset(),
      repositories.audit.reset(),
      repositories.webhookEvents.reset(),
      repositories.messages.reset(),
      repositories.sessions.reset(),
      repositories.deliveries.reset(),
      repositories.autoreplies.reset(),
    ]);
  };

  return repositories;
}
