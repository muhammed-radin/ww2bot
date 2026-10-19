/**
 * Retention and data deletion.
 *
 * Message content is never stored unless the operator opts in. When retention is
 * enabled, stored rows are bounded by `retentionDays` and can be purged on
 * demand (tenant-scoped) or by a scheduled maintenance job.
 */
export class RetentionService {
  constructor({ config, repositories, logger, audit }) {
    this.config = config;
    this.repositories = repositories;
    this.logger = logger;
    this.audit = audit;
  }

  async describe(instance) {
    const storedMessages = await this.repositories.messages.countByInstance(instance.id, instance.tenantId);
    return {
      retainMessageContent: Boolean(instance.retentionEnabled),
      retentionDays: instance.retentionDays,
      globalDefault: {
        retainMessageContent: this.config.retention.retainMessageContent,
        retentionDays: this.config.retention.defaultDays,
        maxRetentionDays: this.config.retention.maxDays,
      },
      storedMessages,
      auditEventsRetentionDays: this.config.retention.auditDays,
    };
  }

  /** Delete every stored row for an instance (messages, webhook dedupe marks, delivery metadata). */
  async purgeInstance(instance, { reason = 'manual', requestId = null, actorKeyId = null } = {}) {
    const [messages, webhookEvents, deliveries] = await Promise.all([
      this.repositories.messages.deleteByInstance(instance.id, instance.tenantId),
      this.repositories.webhookEvents.deleteByInstance(instance.id),
      this.repositories.deliveries?.deleteByInstance(instance.id) ?? 0,
    ]);

    await this.audit?.record({
      action: 'retention.purged',
      result: 'success',
      tenantId: instance.tenantId,
      instanceId: instance.id,
      requestId,
      actorKeyId,
      metadata: { reason, messagesDeleted: messages, webhookEventsDeleted: webhookEvents, deliveriesDeleted: deliveries },
    });

    return { messagesDeleted: messages, webhookEventsDeleted: webhookEvents, deliveriesDeleted: deliveries };
  }

  /** Drop delivery metadata for one instance (used on instance deletion). */
  async purgeDeliveries(instance) {
    if (!this.repositories.deliveries) return 0;
    return this.repositories.deliveries.deleteByInstance(instance.id);
  }

  /** Drop rows older than the instance's retention window. */
  async purgeExpired(instance) {
    if (!instance.retentionEnabled || instance.retentionDays <= 0) {
      return { messagesDeleted: 0, skipped: true };
    }
    const cutoff = new Date(Date.now() - instance.retentionDays * 86400000);
    const messagesDeleted = await this.repositories.messages.purgeBefore(instance.id, cutoff);
    if (messagesDeleted > 0) {
      this.logger?.info({ instanceId: instance.id, messagesDeleted }, 'retention purge removed stored messages');
    }
    return { messagesDeleted, skipped: false, cutoff };
  }

  /** Maintenance sweep across every instance (used by scripts/purge-retained-data.js). */
  async purgeExpiredForAllInstances() {
    const instances = await this.repositories.instances.listAll();
    let total = 0;
    let deliveriesDeleted = 0;
    for (const instance of instances) {
      const result = await this.purgeExpired(instance);
      total += result.messagesDeleted;
      if (this.repositories.deliveries && this.config.outbound?.deliveryRetentionDays > 0) {
        const cutoff = new Date(Date.now() - this.config.outbound.deliveryRetentionDays * 86400000);
        deliveriesDeleted += await this.repositories.deliveries.purgeBefore(instance.id, cutoff);
      }
    }
    const oldWebhooks = await this.repositories.webhookEvents.deleteOlderThan(
      new Date(Date.now() - this.config.retention.defaultDays * 86400000),
    );
    const oldAudit = await this.audit.purgeOlderThan(this.config.retention.auditDays);
    return {
      instances: instances.length,
      messagesDeleted: total,
      webhookEventsDeleted: oldWebhooks,
      auditEventsDeleted: oldAudit,
      deliveriesDeleted,
    };
  }
}
