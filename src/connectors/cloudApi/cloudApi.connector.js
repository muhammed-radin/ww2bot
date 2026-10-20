/**
 * Official WhatsApp Business Platform (Cloud API) connector — the default.
 *
 * What this connector genuinely does:
 *   - verifies the configured business phone number with a documented Graph API
 *     call, so "connected" means "Meta accepts these credentials";
 *   - receives inbound messages and message-status webhooks that the business
 *     account is subscribed to, with signature verification and de-duplication
 *     handled by WebhookService;
 *   - exposes retained inbound messages read-only, and only when the operator
 *     has explicitly enabled retention for the instance.
 *
 * What it does NOT do (and never pretends to):
 *   - no WhatsApp Web QR login or phone pairing;
 *   - no full historical chat export;
 *   - no arbitrary contact list;
 *   - no navigation of personal chat history.
 */
import { CapabilityNotSupportedError, ConnectorError } from '../../utils/errors.js';
import { ConnectionEventType } from '../../events/connectionEvents.js';
import { WhatsAppConnector } from '../connector.interface.js';
import { CloudApiClient } from './cloudApi.client.js';

export class CloudApiConnector extends WhatsAppConnector {
  static type = 'cloud_api';

  constructor({ instance, config, logger, events, messageStore, clientFactory }) {
    super({ instance, config, logger, events });
    this.messageStore = messageStore;
    this.clientFactory =
      clientFactory ??
      (() =>
        new CloudApiClient({
          accessToken: config.connectors.cloud.accessToken,
          phoneNumberId: instance.metadata?.phoneNumberId ?? config.connectors.cloud.phoneNumberId,
          apiVersion: config.connectors.cloud.apiVersion,
          baseUrl: config.connectors.cloud.graphBaseUrl,
          logger,
        }));
    this.client = null;
    this.details = {};
    this.lastCheckedAt = null;
  }

  getCapabilities() {
    const retentionEnabled = Boolean(this.instance.retentionEnabled);
    const cloudConfigured = this.config.connectors.cloud.configured;

    return {
      connector: 'cloud_api',
      official: true,
      description: 'Official WhatsApp Business Platform (Cloud API) connector.',
      enabled: true,
      configured: cloudConfigured,

      // Authentication flows: not offered by the official platform.
      qrAuth: false,
      pairingCode: false,

      // Read endpoints.
      listChats: retentionEnabled,
      getChat: retentionEnabled,
      listMessages: retentionEnabled,
      listContacts: false,
      historicalMessages: false,
      messageRecording: retentionEnabled
        ? 'inbound webhook messages and gateway-sent outbound messages are recorded'
        : 'recording is disabled until retention is enabled for this instance',

      webhooks: this.config.connectors.cloud.webhooksEnabled,
      outboundMessaging: cloudConfigured,
      outboundMessagingTypes: cloudConfigured
        ? ['text', 'image', 'video', 'audio', 'voice', 'document', 'sticker', 'location', 'contact', 'reaction']
        : [],
      mediaDownload: false,
      sendMedia: cloudConfigured,
      sendVoice: cloudConfigured,
      sendSticker: cloudConfigured,
      sendLocation: cloudConfigured,
      sendContact: cloudConfigured,
      sendPoll: false,
      sendReaction: cloudConfigured,
      markChatSeen: false,
      messageReactions: false,
      pollVotes: false,
      maxMediaUploadBytes: this.config.media?.maxUploadBytes ?? null,
      messageContentRetention: retentionEnabled ? 'enabled' : 'disabled',
      limitations: [
        'The Cloud API cannot enumerate personal chats, arbitrary contacts or full message history.',
        retentionEnabled
          ? 'Chat and message endpoints read only messages this gateway recorded: inbound webhook messages and outbound sends made through this API. Pre-existing history is not available.'
          : 'Chat and message endpoints are unavailable until message retention is enabled for this instance.',
        'Connected status means Meta accepted the configured access token and phone number id.',
        'Outbound sends report "accepted" when Meta accepts the request; delivery to the handset is confirmed only by later webhook status events.',
        'Media is uploaded to Meta on send; media downloads for retained history are not supported by this connector.',
        'Native WhatsApp polls cannot be created through the Cloud API and are reported as unsupported rather than emulated.',
        'Calls, chat presence and marking arbitrary retained messages as read are not exposed.',
      ],
    };
  }

  async initialize() {
    this.status = 'initializing';
    await this.events?.publish(this.instance.id, ConnectionEventType.STATUS, {
      status: this.status,
      connector: this.type,
    });

    this.client = this.clientFactory();
    if (!this.config.connectors.cloud.configured) {
      this.status = 'error';
      this.lastError = 'Cloud API credentials are not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).';
      await this.events?.publish(this.instance.id, ConnectionEventType.ERROR, {
        status: this.status,
        connector: this.type,
        message: this.lastError,
        // Configuration is not something reconnection can fix.
        recoverable: false,
      });
      throw new ConnectorError(this.lastError, { connector: this.type });
    }

    try {
      this.details = await this.client.getPhoneNumber();
      this.lastCheckedAt = new Date();
      this.status = 'ready';
      this.lastError = null;
      await this.events?.publish(this.instance.id, ConnectionEventType.AUTHENTICATED, {
        status: this.status,
        connector: this.type,
      });
      await this.events?.publish(this.instance.id, ConnectionEventType.STATUS, {
        status: this.status,
        connector: this.type,
        details: { verifiedName: this.details.verifiedName, displayPhoneNumber: this.details.displayPhoneNumber },
      });
      return { status: this.status, details: this.publicDetails() };
    } catch (error) {
      this.status = 'error';
      this.lastError = 'Credential verification with the WhatsApp Cloud API failed.';
      // A transport/5xx failure may be transient; a 4xx rejection needs the owner.
      const recoverable = !error?.details?.status || Number(error.details.status) >= 500;
      await this.events?.publish(this.instance.id, ConnectionEventType.ERROR, {
        status: this.status,
        connector: this.type,
        message: this.lastError,
        recoverable,
      });
      if (error instanceof ConnectorError) throw error;
      throw new ConnectorError(this.lastError, { connector: this.type });
    }
  }

  publicDetails() {
    return {
      phoneNumberId: this.details?.id ?? null,
      displayPhoneNumber: this.details?.displayPhoneNumber ?? null,
      verifiedName: this.details?.verifiedName ?? null,
      qualityRating: this.details?.qualityRating ?? null,
      lastCheckedAt: this.lastCheckedAt?.toISOString() ?? null,
    };
  }

  async getStatus() {
    return { status: this.status, details: this.publicDetails(), lastError: this.lastError };
  }

  async listChats(options) {
    this.#assertRetention('list chats');
    return this.messageStore.listChats(this.instance, options);
  }

  async getChat(chatId, options) {
    this.#assertRetention('read a chat');
    return this.messageStore.getChat(this.instance, chatId, options);
  }

  async listMessages(chatId, options) {
    this.#assertRetention('read messages');
    return this.messageStore.listMessages(this.instance, chatId, options);
  }

  async listContacts() {
    throw new CapabilityNotSupportedError(
      'The Cloud API connector cannot enumerate contacts. Contacts are not exposed by the official platform.',
      { connector: this.type, operation: 'listContacts' },
    );
  }

  async requestQrAuth() {
    throw new CapabilityNotSupportedError(
      'The Cloud API connector has no QR authentication flow; authentication is via the access token configured by the operator.',
      { connector: this.type, operation: 'requestQrAuth' },
    );
  }

  async requestPairingCode() {
    throw new CapabilityNotSupportedError(
      'The Cloud API connector has no phone-number pairing code flow.',
      { connector: this.type, operation: 'requestPairingCode' },
    );
  }

  /**
   * Send a message through the official Cloud API.
   *
   * Returns status "accepted" when Meta accepts the request. It never claims the
   * message was delivered: final delivery is confirmed by webhook status events.
   */
  async sendMessage({ to, type = 'text', text, media, caption, filename, voice, asDocument, asSticker, location, contact, contactId, poll, replyToMessageId }) {
    if (!this.config.connectors.cloud.configured) {
      throw new CapabilityNotSupportedError(
        'The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).',
        { connector: this.type, operation: 'sendMessage' },
      );
    }
    if (poll) {
      throw new CapabilityNotSupportedError(
        'The Cloud API cannot create native WhatsApp polls. Use the WhatsApp Web connector for polls.',
        { connector: this.type, operation: 'sendMessage', type: 'poll' },
      );
    }
    if (!this.client) this.client = this.clientFactory();
    // The Graph API addresses recipients by phone number; a full chat id
    // (for example 131355503402@c.us) is reduced to its user part.
    const recipient = String(to).includes('@') ? String(to).replace(/@.*$/, '') : String(to);
    let result;
    if (type === 'text') {
      result = await this.client.sendTextMessage({ to: recipient, text });
    } else if (['image', 'video', 'audio', 'voice', 'document', 'sticker'].includes(type)) {
      if (typeof this.client.sendMediaMessage !== 'function') {
        throw new CapabilityNotSupportedError('The configured Cloud API client cannot send media.', {
          connector: this.type,
          operation: 'sendMessage',
          type,
        });
      }
      result = await this.client.sendMediaMessage({
        to: recipient,
        type: type === 'voice' ? 'audio' : type,
        media,
        caption,
        filename,
        voice: type === 'voice' || Boolean(voice),
        asDocument: Boolean(asDocument),
        asSticker: Boolean(asSticker),
        replyToMessageId,
      });
    } else if (type === 'location') {
      result = await this.client.sendLocationMessage({ to: recipient, location });
    } else if (type === 'contact') {
      const resolved = contact ?? null;
      if (!resolved && contactId) {
        throw new CapabilityNotSupportedError(
          'The Cloud API cannot resolve a contact id. Supply a contact name and phone number instead.',
          { connector: this.type, operation: 'sendMessage', type: 'contact' },
        );
      }
      result = await this.client.sendContactMessage({ to: recipient, contact: resolved });
    } else {
      throw new CapabilityNotSupportedError(`The Cloud API connector cannot send "${type}" messages.`, {
        connector: this.type,
        operation: 'sendMessage',
        type,
      });
    }
    await this.events?.publish(this.instance.id, ConnectionEventType.METRIC, {
      connector: this.type,
      operation: 'sendMessage',
      type,
      status: result.status,
    });
    return result;
  }

  /** Add or remove a reaction through the Cloud API. */
  async sendReaction({ chatId, messageId, reaction }) {
    if (!this.config.connectors.cloud.configured) {
      throw new CapabilityNotSupportedError(
        'The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).',
        { connector: this.type, operation: 'sendReaction' },
      );
    }
    if (!this.client) this.client = this.clientFactory();
    const recipient = String(chatId).includes('@') ? String(chatId).replace(/@.*$/, '') : String(chatId);
    const result = await this.client.sendReactionMessage({ to: recipient, messageId, reaction });
    await this.events?.publish(this.instance.id, ConnectionEventType.METRIC, {
      connector: this.type,
      operation: 'sendReaction',
      status: result.status,
    });
    return result;
  }

  async downloadMedia() {
    throw new CapabilityNotSupportedError(
      'The Cloud API connector cannot download media for retained history. Media ids are only available on the inbound webhook and are not retained.',
      { connector: this.type, operation: 'downloadMedia' },
    );
  }

  async markChatSeen() {
    throw new CapabilityNotSupportedError(
      'The Cloud API connector cannot mark an arbitrary retained chat as read.',
      { connector: this.type, operation: 'markChatSeen' },
    );
  }

  async getMessageReactions() {
    throw new CapabilityNotSupportedError(
      'Reactions for retained Cloud API messages are not exposed.',
      { connector: this.type, operation: 'getMessageReactions' },
    );
  }

  async getPollVotes() {
    throw new CapabilityNotSupportedError(
      'The Cloud API connector does not support native polls or vote tallies.',
      { connector: this.type, operation: 'getPollVotes' },
    );
  }

  async disconnect() {
    // There is no session to tear down: the official platform keeps the number
    // registered. Marking the instance disconnected stops local polling only.
    this.status = 'disconnected';
    await this.events?.publish(this.instance.id, ConnectionEventType.DISCONNECTED, {
      status: this.status,
      connector: this.type,
      reason: 'disconnected_by_operator',
    });
    return { status: this.status, sessionRevoked: false, note: 'The Cloud API keeps the phone number registered.' };
  }

  async destroy() {
    this.status = 'destroyed';
    this.client = null;
  }

  #assertRetention(operation) {
    if (!this.instance.retentionEnabled) {
      throw new CapabilityNotSupportedError(
        `The Cloud API connector cannot ${operation}: message content retention is disabled for this instance. ` +
          'Enable retention to read inbound messages that the gateway received via webhooks.',
        { connector: this.type, operation, retentionEnabled: false },
      );
    }
  }
}
