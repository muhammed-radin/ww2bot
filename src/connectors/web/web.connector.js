/**
 * Authorised WhatsApp Web connector (whatsapp-web.js + Puppeteer).
 *
 * DISABLED BY DEFAULT. This connector is only constructed when the operator has
 * set ENABLE_WHATSAPP_WEB_CONNECTOR=true and recorded the written authorization
 * they hold in WHATSAPP_WEB_AUTHORIZATION_REFERENCE. It is NOT an official
 * WhatsApp API and must not be presented as one.
 *
 * Verified against whatsapp-web.js v1.34.x:
 *   - QR login: the `qr` event, replaced whenever WhatsApp issues a new code;
 *   - pairing code: the pair must be requested through the CONSTRUCTOR
 *     (`pairWithPhoneNumber`), the code arrives on the `code` event. Calling
 *     requestPairingCode() on a client built for QR throws in this version, so
 *     this connector rebuilds the client in pairing mode instead of calling it
 *     from the `qr` handler.
 *
 * Deliberate non-features: no stealth/anti-detection plugins, no attempts to
 * defeat platform restrictions, no unsupported-operation shims. Anything the
 * installed library cannot do is reported through CapabilityNotSupportedError.
 *
 * Compatibility note: on current WhatsApp Web builds, whatsapp-web.js 1.34.7's
 * getChats()/getChatById() reject with an opaque "r" error (an internal
 * message-key field was renamed `_serialized` -> `$1`). Chat and message reads
 * therefore go through a direct page-store read that skips individual bad
 * entries, falling back to the library API when the page is unavailable.
 */
import QRCode from 'qrcode';
import { CapabilityNotSupportedError, ConflictError, ConnectorDisabledError, ConnectorError, ErrorCode, ValidationError } from '../../utils/errors.js';
import { ConnectionEventType } from '../../events/connectionEvents.js';
import { WhatsAppConnector } from '../connector.interface.js';
import { withTimeout } from './browserManager.js';
import { createEncryptedSessionStore } from './sessionStore.js';

const CHAT_ID_PATTERN = /^[A-Za-z0-9@._-]{5,80}$/;
const MAX_CONTACTS_SCAN = 5000;
const MAX_CHATS_SCAN = 5000;
const MAX_RECENT_MESSAGES = 500;

export class WebConnector extends WhatsAppConnector {
  static type = 'web';

  constructor({ instance, config, logger, events, sessionService, browserManager, libraryFactory, messageStore = null, onInboundMessage = null }) {
    super({ instance, config, logger, events });
    this.sessionService = sessionService;
    this.browserManager = browserManager;
    this.libraryFactory = libraryFactory ?? null;
    this.messageStore = messageStore;
    this.onInboundMessage = onInboundMessage;
    this.client = null;
    this.mode = null; // 'qr' | 'pairing_code'
    this.qrState = null; // { dataUrl, expiresAt, attempt }
    this.pairingState = null; // { expiresAt } (the code itself is never stored in status)
    this.loading = null; // { percent, message, complete, at } during post-auth sync
    this.authState = null; // latest library connection state (WAState)
    this.launching = false;
    this.intentionalDisconnect = false;
    this.qrTimer = null;
    this.pairingTimer = null;
    this.pairingWaiter = null;
    this.qrWaiters = [];
    // Bounded, in-memory record of messages seen since this client started.
    // Bodies are only written to disk by messageStore when retention is on.
    this.recentMessages = [];
    this.seenMessageIds = new Set();
  }

  /** Resolve once a QR challenge is available, or after `timeoutMs`. */
  #awaitFirstQr(timeoutMs = 3000) {
    const current = this.currentQr();
    if (current) return Promise.resolve(current);
    return new Promise((resolve) => {
      const timer = setTimeout(() => resolve(this.currentQr()), timeoutMs);
      timer.unref?.();
      this.qrWaiters.push(() => {
        clearTimeout(timer);
        resolve(this.currentQr());
      });
    });
  }

  /* ------------------------------------------------------------------ */
  /* capabilities                                                        */
  /* ------------------------------------------------------------------ */

  getCapabilities() {
    if (!this.config.connectors.web.enabled) {
      return {
        connector: 'web',
        official: false,
        enabled: false,
        authorizationReference: null,
        qrAuth: false,
        pairingCode: false,
        listChats: false,
        getChat: false,
        listMessages: false,
        listContacts: false,
        historicalMessages: false,
        webhooks: false,
        outboundMessaging: false,
        limitations: [
          'The WhatsApp Web connector is disabled. Enable it only with the written authorization required for your use case.',
        ],
      };
    }

    return {
      connector: 'web',
      official: false,
      enabled: true,
      authorizationReference: this.config.connectors.web.authorizationReference,
      description:
        'Authorised WhatsApp Web connector backed by whatsapp-web.js. Not an official WhatsApp API.',
      qrAuth: true,
      pairingCode: true,
      listChats: true,
      getChat: true,
      listMessages: true,
      listContacts: true,
      // Honest limit: the library can only read what the linked device holds
      // locally, and fetchMessages returns a bounded recent window.
      historicalMessages: 'partial: recent messages available on the linked device only',
      messageRecording:
        'incoming and outgoing messages are recorded live; bodies persist only when retention is enabled',
      webhooks: false,
      // Text-only send on behalf of the linked device. This is NOT the official
      // WhatsApp Business Platform and carries the account's own risk.
      outboundMessaging: true,
      outboundMessagingTypes: ['text'],
      sessionStrategy: this.config.connectors.web.authStrategy,
      atRestEncryption:
        this.config.connectors.web.authStrategy === 'remote_encrypted'
          ? 'session archives encrypted with AES-256-GCM before storage'
          : 'browser profile stored on disk; encryption depends on the hosting volume',
      limitations: [
        'Requires authorization for the exact intended use; it is not an official WhatsApp API.',
        'Message history is limited to what the linked device can provide; there is no complete historical export.',
        'A running linked browser can read decrypted message content.',
        'Only one linked session per instance; cookies and profiles are never shared between instances.',
        'Outbound sends use the linked device and are text-only; for production business messaging use the official WhatsApp Business Platform.',
        'A send is reported as "sent" once the linked device hands it to WhatsApp; delivery is not independently confirmed.',
      ],
    };
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle                                                           */
  /* ------------------------------------------------------------------ */

  #assertEnabled() {
    if (!this.config.connectors.web.enabled) {
      throw new ConnectorDisabledError(
        'The WhatsApp Web connector is disabled. It requires explicit operator authorization and ENABLE_WHATSAPP_WEB_CONNECTOR=true.',
        { connector: 'web', enabled: false },
      );
    }
  }

  async #loadLibrary() {
    if (this.libraryFactory) return this.libraryFactory();
    try {
      const module = await import('whatsapp-web.js');
      return module?.default ?? module;
    } catch (error) {
      throw new ConnectorError(
        'whatsapp-web.js is not installed. Install the optional dependencies with: npm run setup:web-connector',
        { cause: error?.message },
      );
    }
  }

  #buildAuthStrategy({ directory, library, sessionService, instance, logger }) {
    const { authStrategy } = this.config.connectors.web;
    if (authStrategy === 'remote_encrypted') {
      if (!library.RemoteAuth) {
        throw new ConnectorError('The installed whatsapp-web.js version does not export RemoteAuth.');
      }
      return new library.RemoteAuth({
        clientId: instance.id,
        dataPath: directory,
        backupSyncIntervalMs: 60000,
        store: createEncryptedSessionStore({ sessionService, instance, logger }),
      });
    }
    if (!library.LocalAuth) {
      throw new ConnectorError('The installed whatsapp-web.js version does not export LocalAuth.');
    }
    return new library.LocalAuth({ clientId: instance.id, dataPath: directory });
  }

  /**
   * Start the browser and begin authentication.
   * @param {{mode?: 'qr'|'pairing_code', phoneNumber?: string}} [options]
   */
  async initialize({ mode = 'qr', phoneNumber = null } = {}) {
    this.#assertEnabled();
    if (this.launching) {
      throw new ConflictError(ErrorCode.INSTANCE_BUSY, 'The connector is already starting.');
    }
    if (mode === 'pairing_code' && !phoneNumber) {
      throw new ValidationError('A phone number is required for pairing-code authentication.', { field: 'phoneNumber' });
    }

    this.launching = true;
    this.intentionalDisconnect = false;
    let directory;
    try {
      // Admission control runs before any state change: a rejected start (busy
      // instance, or the process-wide browser limit) leaves the connector as it
      // was and must never leak the `launching` flag.
      directory = await this.sessionService.ensureInstanceDirectory(this.instance);
      this.browserManager.reserve(this.instance.id);
    } catch (error) {
      this.launching = false;
      throw error;
    }

    this.mode = mode;
    this.status = mode === 'pairing_code' ? 'awaiting_pairing_code' : 'awaiting_qr';

    await this.events?.publish(this.instance.id, ConnectionEventType.STATUS, {
      status: this.status,
      connector: this.type,
      mode,
    });

    try {
      const library = await this.#loadLibrary();
      const clientOptions = this.#buildClientOptions(library, directory, { mode, phoneNumber });
      this.client = new library.Client(clientOptions);
      this.browserManager.attach(this.instance.id, { client: this.client, browser: this.client.pupBrowser ?? null, mode });
      this.#attachEventHandlers(this.client);

      await withTimeout(
        this.client.initialize(),
        this.config.connectors.web.launchTimeoutMs,
        'Timed out while starting the WhatsApp Web browser session.',
      );

      this.status = this.client.info ? 'ready' : this.status;
      return { status: this.status, details: this.publicDetails() };
    } catch (error) {
      this.status = 'error';
      this.lastError = error instanceof ConnectorError ? error.message : 'Failed to start the WhatsApp Web session.';
      this.logger?.error({ err: error, instanceId: this.instance.id }, 'whatsapp web connector initialisation failed');
      // Configuration/validation/busy errors are not fixed by retrying.
      const recoverable =
        !(error instanceof ConnectorDisabledError) && !(error instanceof ValidationError) && !(error instanceof ConflictError);
      await this.events?.publish(this.instance.id, ConnectionEventType.ERROR, {
        status: this.status,
        connector: this.type,
        message: this.lastError,
        recoverable,
      });
      await this.#teardownClient({ logout: false });
      if (error instanceof ConnectorError || error instanceof ConflictError) throw error;
      throw new ConnectorError(this.lastError, { connector: 'web' });
    } finally {
      this.launching = false;
    }
  }

  #buildClientOptions(library, directory, { mode, phoneNumber }) {
    const puppeteerOptions = {
      headless: this.config.connectors.web.headless,
      // The Chromium sandbox is intentionally NOT disabled by default. The
      // container runs as a non-root user; see README for the required
      // container privileges.
      args: [
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--disable-default-apps',
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-background-networking',
        '--disable-sync',
      ],
      timeout: this.config.connectors.web.launchTimeoutMs,
      // No fixed remote-debugging-port: never expose DevTools on a public port.
    };

    // Opt-in escape hatch for hosts where unprivileged user namespaces are
    // blocked (Ubuntu 23.10+ with AppArmor, some container runtimes) and the
    // SUID sandbox cannot be configured. It is never enabled by default.
    if (this.config.connectors.web.noSandbox) {
      puppeteerOptions.args.push('--no-sandbox', '--disable-setuid-sandbox');
    }

    const options = {
      authStrategy: this.#buildAuthStrategy({
        directory,
        library,
        sessionService: this.sessionService,
        instance: this.instance,
        logger: this.logger,
      }),
      puppeteer: puppeteerOptions,
      authTimeoutMs: this.config.connectors.web.launchTimeoutMs,
      qrMaxRetries: 0,
      takeoverOnConflict: false,
      deviceName: `razorbills-whatsapp:${this.instance.id.slice(0, 12)}`,
    };

    if (mode === 'pairing_code') {
      options.pairWithPhoneNumber = {
        phoneNumber,
        showNotification: false,
        intervalMs: this.config.connectors.web.pairingIntervalMs,
      };
    }

    return options;
  }

  #attachEventHandlers(client) {
    client.on('qr', (qr) => {
      this.#handleQr(qr).catch((error) =>
        this.logger?.error({ err: error, instanceId: this.instance.id }, 'failed to publish QR challenge'),
      );
    });

    client.on('code', (code) => {
      this.#handlePairingCode(code).catch((error) =>
        this.logger?.error({ err: error, instanceId: this.instance.id }, 'failed to publish pairing code'),
      );
    });

    client.on('authenticated', () => {
      this.#clearQr();
      this.loading = null;
      this.status = 'authenticated';
      this.events?.publish(this.instance.id, ConnectionEventType.AUTHENTICATED, {
        status: this.status,
        connector: this.type,
      });
    });

    client.on('ready', () => {
      this.#clearQr();
      this.loading = null;
      this.status = 'ready';
      this.lastError = null;
      this.events?.publish(this.instance.id, ConnectionEventType.STATUS, {
        status: this.status,
        connector: this.type,
        details: this.publicDetails(),
      });
    });

    client.on('auth_failure', (message) => {
      this.status = 'error';
      this.loading = null;
      this.lastError = 'WhatsApp Web authentication failed.';
      this.logger?.warn({ instanceId: this.instance.id }, 'whatsapp web authentication failure');
      this.events?.publish(this.instance.id, ConnectionEventType.ERROR, {
        status: this.status,
        connector: this.type,
        message: this.lastError,
        detail: typeof message === 'string' ? message.slice(0, 200) : undefined,
        // A rejected pairing needs the owner to start over, not a retry loop.
        recoverable: false,
      });
    });

    client.on('disconnected', (reason) => {
      this.status = 'disconnected';
      this.#clearQr();
      this.loading = null;
      this.authState = null;
      this.events?.publish(this.instance.id, ConnectionEventType.DISCONNECTED, {
        status: this.status,
        connector: this.type,
        reason: typeof reason === 'string' ? reason.slice(0, 120) : 'unknown',
        // An unexpected drop may recover; an operator-initiated one must not.
        recoverable: !this.intentionalDisconnect,
      });
      this.browserManager.release(this.instance.id, { destroy: true }).catch(() => {});
    });

    client.on('change_state', (state) => {
      this.authState = typeof state === 'string' ? state : null;
      this.events?.publish(this.instance.id, ConnectionEventType.AUTH_STATE, {
        connector: this.type,
        state: this.authState,
      });
    });

    // Live incoming and outgoing messages. `message` covers received traffic;
    // `message_create` covers everything the linked account creates (including
    // sends made through this API and messages typed on the phone). Duplicate
    // emission is de-duplicated by provider message id.
    client.on('message', (message) => {
      this.#handleLibraryMessage(message).catch((error) =>
        this.logger?.error({ err: error, instanceId: this.instance.id }, 'failed to record an inbound message'),
      );
    });
    client.on('message_create', (message) => {
      this.#handleLibraryMessage(message).catch((error) =>
        this.logger?.error({ err: error, instanceId: this.instance.id }, 'failed to record an outgoing message'),
      );
    });

    // Post-authentication sync progress ("loading screen"). whatsapp-web.js
    // emits (percent, message); percentages are advertised verbatim, never
    // extrapolated. This is what a phone shows as "loading your chats".
    client.on('loading_screen', (percent, message) => {
      this.#handleLoading(percent, message).catch((error) =>
        this.logger?.error({ err: error, instanceId: this.instance.id }, 'failed to publish loading progress'),
      );
    });
  }

  /* ------------------------------------------------------------------ */
  /* QR authentication                                                   */
  /* ------------------------------------------------------------------ */

  async #handleQr(qrPayload) {
    if (!qrPayload) return;
    this.qrState = { ...(this.qrState ?? {}), attempt: (this.qrState?.attempt ?? 0) + 1 };
    const attempt = this.qrState.attempt;

    const dataUrl = await QRCode.toDataURL(qrPayload, {
      errorCorrectionLevel: 'M',
      type: 'image/png',
      width: 320,
      margin: 1,
    });

    // A newer QR may have arrived while we were rendering: keep only the latest.
    if (this.qrState.attempt !== attempt) return;

    const expiresAt = new Date(Date.now() + this.config.limits.qrTtlMs);
    this.qrState = { dataUrl, expiresAt, attempt };
    this.status = 'awaiting_qr';

    await this.events?.publish(this.instance.id, ConnectionEventType.QR, {
      connector: this.type,
      attempt,
      expiresAt: expiresAt.toISOString(),
      ttlMs: this.config.limits.qrTtlMs,
      qrDataUrl: dataUrl,
      // The raw payload is embedded in the data URL; it is never logged.
    });

    this.#scheduleQrExpiry(expiresAt);

    // Wake any caller waiting for the first challenge of this session.
    for (const waiter of this.qrWaiters.splice(0)) waiter();
  }

  #scheduleQrExpiry(expiresAt) {
    clearTimeout(this.qrTimer);
    this.qrTimer = setTimeout(() => {
      if (this.qrState?.expiresAt && this.qrState.expiresAt <= new Date()) {
        this.qrState = null;
        this.events?.publish(this.instance.id, ConnectionEventType.QR_EXPIRED, { connector: this.type });
      }
    }, Math.max(this.config.limits.qrTtlMs, 1000));
    this.qrTimer.unref?.();
  }

  #clearQr() {
    clearTimeout(this.qrTimer);
    this.qrTimer = null;
    this.qrState = null;
  }

  async requestQrAuth() {
    this.#assertEnabled();
    if (this.status === 'ready') {
      return { status: this.status, details: this.publicDetails(), alreadyConnected: true };
    }
    if (this.browserManager.isRunning(this.instance.id) && this.mode === 'qr') {
      // Already producing QR challenges: return the current one instead of
      // starting a second browser for the same instance.
      return { status: this.status, details: this.publicDetails(), qr: this.currentQr() };
    }
    if (this.mode === 'pairing_code') {
      await this.#teardownClient({ logout: false });
    }
    await this.initialize({ mode: 'qr' });
    // Give the library a brief window to produce the first challenge so the
    // response can include it; later challenges still arrive over the stream.
    const qr = await this.#awaitFirstQr(Math.min(this.config.limits.qrTtlMs, 3000));
    return { status: this.status, details: this.publicDetails(), qr };
  }

  /** @returns {{qrDataUrl:string, expiresAt:string, attempt:number}|null} */
  currentQr() {
    if (!this.qrState?.dataUrl || !this.qrState.expiresAt) return null;
    if (this.qrState.expiresAt <= new Date()) return null;
    return {
      qrDataUrl: this.qrState.dataUrl,
      expiresAt: this.qrState.expiresAt.toISOString(),
      attempt: this.qrState.attempt ?? 1,
    };
  }

  /* ------------------------------------------------------------------ */
  /* pairing code                                                        */
  /* ------------------------------------------------------------------ */

  /**
   * Request a phone-number pairing code.
   *
   * whatsapp-web.js only honours the constructor `pairWithPhoneNumber` option,
   * so a client already running in QR mode is torn down and rebuilt. A code that
   * is still valid is returned as-is unless `force` is set, so clients do not
   * trigger repeated code generation.
   */
  async requestPairingCode(phoneNumber, { force = false } = {}) {
    this.#assertEnabled();
    if (this.pairingState?.code && this.pairingState.expiresAt > new Date() && !force) {
      return {
        status: this.status,
        pairingCode: this.pairingState.code,
        expiresAt: this.pairingState.expiresAt.toISOString(),
        reused: true,
        details: this.publicDetails(),
      };
    }

    if (this.pairingState && this.pairingState.expiresAt > new Date() && force) {
      throw new ConflictError(
        ErrorCode.CONFLICT,
        'A pairing code is already pending for this instance. Wait for it to expire or disconnect before forcing a new one.',
      );
    }

    if (this.mode !== 'pairing_code') {
      await this.#teardownClient({ logout: false });
    }

    this.pairingState = null;
    const code = await this.#startPairing(phoneNumber);
    return {
      status: this.status,
      pairingCode: code.value,
      expiresAt: code.expiresAt.toISOString(),
      reused: false,
      details: this.publicDetails(),
    };
  }

  async #startPairing(phoneNumber) {
    const waitForCode = new Promise((resolve, reject) => {
      this.pairingWaiter = { resolve, reject };
    });

    await this.initialize({ mode: 'pairing_code', phoneNumber });

    const timeoutMs = this.config.connectors.web.pairingIntervalMs;
    let timer;
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(
        () => reject(new ConnectorError('WhatsApp did not return a pairing code before the request timed out.', { connector: 'web' })),
        Math.min(timeoutMs, 60000),
      );
      timer.unref?.();
    });

    try {
      return await Promise.race([waitForCode, timeout]);
    } catch (error) {
      this.status = 'error';
      this.lastError = 'Pairing-code authentication did not complete.';
      await this.events?.publish(this.instance.id, ConnectionEventType.ERROR, {
        status: this.status,
        connector: this.type,
        message: this.lastError,
      });
      await this.#teardownClient({ logout: false });
      throw error instanceof ConnectorError ? error : new ConnectorError(this.lastError, { connector: 'web' });
    } finally {
      clearTimeout(timer);
    }
  }

  async #handlePairingCode(code) {
    if (!code || typeof code !== 'string') return;
    // The code is a login credential: it is emitted to authorised subscribers and
    // returned to the caller of the endpoint, never written to a log.
    const expiresAt = new Date(Date.now() + this.config.connectors.web.pairingIntervalMs);
    this.pairingState = { code, expiresAt };
    this.status = 'awaiting_pairing_code';
    await this.events?.publish(this.instance.id, ConnectionEventType.PAIRING_CODE, {
      connector: this.type,
      pairingCode: code,
      expiresAt: expiresAt.toISOString(),
    });
    this.pairingWaiter?.resolve({ value: code, expiresAt });
    this.pairingWaiter = null;
  }

  /* ------------------------------------------------------------------ */
  /* live messages                                                       */
  /* ------------------------------------------------------------------ */

  /** Convert a library Message into the gateway's public message shape. */
  #normaliseLibraryMessage(message, direction) {
    const providerMessageId = message?.id?._serialized ?? message?.id?.id ?? null;
    const fromMe = Boolean(message?.fromMe);
    const chatId = fromMe ? (message?.to ?? message?.from ?? null) : (message?.from ?? message?.to ?? null);
    const sentAt = message?.timestamp ? new Date(Number(message.timestamp) * 1000) : new Date();
    return {
      id: providerMessageId,
      chatId,
      direction,
      type: typeof message?.type === 'string' ? message.type : 'unknown',
      body: typeof message?.body === 'string' ? message.body : null,
      from: message?.from ?? null,
      to: message?.to ?? null,
      fromMe,
      hasMedia: Boolean(message?.hasMedia),
      timestamp: Number.isNaN(sentAt.getTime()) ? new Date().toISOString() : sentAt.toISOString(),
      source: 'whatsapp_web',
    };
  }

  async #handleLibraryMessage(message) {
    if (!message || this.status !== 'ready') return;
    const direction = message.fromMe ? 'outbound' : 'inbound';
    const normalised = this.#normaliseLibraryMessage(message, direction);
    // A message without a chat or provider id cannot be de-duplicated safely;
    // skip it rather than writing an ambiguous row.
    if (!normalised.chatId || !normalised.id) return;
    if (this.seenMessageIds.has(normalised.id)) return;
    this.#rememberMessage(normalised);

    await this.messageStore?.storeMessages(
      this.instance,
      [
        {
          chatId: normalised.chatId,
          providerMessageId: normalised.id,
          direction,
          messageType: normalised.type,
          body: normalised.body,
          fromId: normalised.from,
          toId: normalised.to,
          sentAt: new Date(normalised.timestamp),
          metadata: { hasMedia: normalised.hasMedia, source: 'whatsapp_web' },
        },
      ],
      { direction },
    );

    await this.events?.publish(
      this.instance.id,
      direction === 'inbound' ? ConnectionEventType.MESSAGE : ConnectionEventType.MESSAGE_SENT,
      {
        connector: this.type,
        direction,
        chatId: normalised.chatId,
        messageId: normalised.id,
        type: normalised.type,
        body: normalised.body,
        from: normalised.from,
        to: normalised.to,
        timestamp: normalised.timestamp,
        hasMedia: normalised.hasMedia,
        // The linked device already exposes this content live over the
        // authenticated API; it is only written to disk when retention is
        // enabled (messageStore enforces that).
      },
    );

    if (direction === 'inbound' && this.onInboundMessage) {
      try {
        await this.onInboundMessage(this.instance, normalised);
      } catch (error) {
        this.logger?.error({ err: error, instanceId: this.instance.id }, 'inbound message handler failed');
      }
    }
  }

  #rememberMessage(normalised) {
    this.seenMessageIds.add(normalised.id);
    if (this.seenMessageIds.size > MAX_RECENT_MESSAGES) {
      const oldest = this.seenMessageIds.values().next().value;
      if (oldest) this.seenMessageIds.delete(oldest);
    }
    this.recentMessages.unshift(normalised);
    if (this.recentMessages.length > MAX_RECENT_MESSAGES) this.recentMessages.length = MAX_RECENT_MESSAGES;
  }

  /**
   * Bounded live buffer used when retention is disabled. It never fabricates
   * history: only messages observed during this connection are present.
   */
  listRecentMessages({ limit = 25, direction = null, chatId = null } = {}) {
    let items = this.recentMessages;
    if (chatId) items = items.filter((message) => message.chatId === chatId);
    if (direction) items = items.filter((message) => message.direction === direction);
    return {
      items: items.slice(0, limit),
      hasMore: false,
      limitations: [
        'Live buffer: only messages observed since this WhatsApp Web session started are listed.',
        'Enable retention to persist message content across restarts.',
      ],
    };
  }

  getMessageById(messageId) {
    return this.recentMessages.find((message) => message.id === messageId) ?? null;
  }

  /* ------------------------------------------------------------------ */
  /* session sync progress                                               */
  /* ------------------------------------------------------------------ */

  /**
   * Record and publish post-authentication sync progress.
   *
   * whatsapp-web.js emits `loading_screen` with a percentage while the linked
   * device synchronises chats. The value is passed through unchanged (clamped
   * to 0–100) so the dashboard never fabricates progress.
   */
  async #handleLoading(percent, message) {
    const numeric = Number(percent);
    const value = Number.isFinite(numeric) ? Math.max(0, Math.min(100, Math.round(numeric))) : null;
    const label = typeof message === 'string' && message.length > 0 ? message.slice(0, 80) : null;
    this.loading = {
      percent: value,
      message: label,
      complete: value === 100,
      at: new Date().toISOString(),
    };
    if (this.status !== 'ready') this.status = 'authenticated';

    await this.events?.publish(this.instance.id, ConnectionEventType.LOADING, {
      connector: this.type,
      percent: this.loading.percent,
      message: this.loading.message,
      complete: this.loading.complete,
    });
  }

  /* ------------------------------------------------------------------ */
  /* status                                                              */
  /* ------------------------------------------------------------------ */

  publicDetails() {
    const info = this.client?.info ?? null;
    return {
      authMode: this.mode,
      sessionStrategy: this.config.connectors.web.authStrategy,
      linkedUser: info?.wid?.user ?? null,
      platform: info?.platform ?? null,
      pushname: info?.pushname ?? null,
      deviceName: `razorbills-whatsapp:${this.instance.id.slice(0, 12)}`,
      qrExpiresAt: this.qrState?.expiresAt?.toISOString() ?? null,
      pairingExpiresAt: this.pairingState?.expiresAt?.toISOString() ?? null,
      // Session sync progress and the library's own connection state, so a
      // client that polls (rather than streaming) still sees them.
      loading: this.loading,
      authState: this.authState,
      // The pairing code itself is never part of the status payload.
    };
  }

  async getStatus() {
    return {
      status: this.status,
      details: this.publicDetails(),
      lastError: this.lastError,
      qr: this.currentQr(),
    };
  }

  /* ------------------------------------------------------------------ */
  /* read-only data                                                      */
  /* ------------------------------------------------------------------ */

  #assertReadyForData() {
    if (this.status !== 'ready') {
      throw new ConflictError(
        ErrorCode.INSTANCE_NOT_CONNECTED,
        'The instance is not connected. Complete QR or pairing-code authentication first.',
        { status: this.status },
      );
    }
  }

  /**
   * Run a whatsapp-web.js call and translate an opaque library failure into a
   * safe, actionable connector error. Without this a page-context failure (for
   * example after the linked browser was closed) surfaced as a bare 500.
   */
  async #callLibrary(operation, fn) {
    if (!this.client) {
      throw new ConflictError(
        ErrorCode.INSTANCE_NOT_CONNECTED,
        'The instance is not connected. Complete QR or pairing-code authentication first.',
        { status: this.status },
      );
    }
    try {
      return await fn();
    } catch (error) {
      if (error?.isOperational) throw error;
      this.logger?.warn({ err: error, instanceId: this.instance.id, operation }, 'whatsapp web library call failed');
      throw new ConnectorError(
        `The linked WhatsApp Web session could not ${operation}. Re-link the device if this keeps happening.`,
        { connector: 'web', operation },
      );
    }
  }

  /** The library's page handle, or null when it is unavailable (test double). */
  #page() {
    const page = this.client?.pupPage;
    return page && typeof page.evaluate === 'function' ? page : null;
  }

  /**
   * Read the WhatsApp Web chat collection directly from the page.
   *
   * whatsapp-web.js 1.34.7 builds every chat through getChatModel(), which runs
   * chat.serialize(). On current WhatsApp Web builds that throws for some chats
   * (an internal message-key field was renamed from `_serialized` to `$1`, and
   * group metadata handling changed), so getChats()/getChatById() reject as a
   * whole with an opaque single-letter "r" error even though the session is
   * healthy. This reads the same store the library reads, one chat at a time and
   * only primitive fields, so a chat that cannot be read is skipped instead of
   * failing every chat. It returns null when the page is unavailable, so the
   * caller falls back to the library API (for example the test double).
   */
  async #readChatsFromStore({ chatId = null, limit = MAX_CHATS_SCAN } = {}) {
    const page = this.#page();
    if (!page) return null;
    try {
      const rows = await page.evaluate(
        (chatId, limit) => {
          const collections = window.require('WAWebCollections');
          const record = (chat) => {
            const id = chat?.id?._serialized ?? (typeof chat?.id === 'string' ? chat.id : null);
            if (!id) return null;
            const mute = chat.mute;
            return {
              // Shaped like a serialised library chat so the same mapper applies.
              id: { _serialized: id },
              name: chat.name ?? chat.formattedTitle ?? null,
              // `chat.isGroup` is not dependable on current builds; the id suffix is.
              isGroup: id.endsWith('@g.us'),
              unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
              archived: Boolean(chat.archive ?? chat.archived),
              pinned: Boolean(chat.pin ?? chat.pinned),
              isMuted: mute ? mute.expiration !== 0 : Boolean(chat.isMuted),
              // The raw page model keeps the last-activity time in `t`.
              timestamp:
                typeof chat.timestamp === 'number' ? chat.timestamp : typeof chat.t === 'number' ? chat.t : null,
            };
          };
          if (chatId) {
            const wid = window.require('WAWebWidFactory').createWid(chatId);
            const chat = collections.Chat.get(wid);
            const found = chat ? record(chat) : null;
            return found ? [found] : [];
          }
          const out = [];
          for (const chat of collections.Chat.getModelsArray()) {
            try {
              const item = record(chat);
              if (item) out.push(item);
            } catch {
              // One unreadable chat must never hide the rest of the list.
            }
            if (out.length >= limit) break;
          }
          return out;
        },
        chatId,
        limit,
      );
      return Array.isArray(rows) ? rows.map(serialiseChat) : null;
    } catch (error) {
      this.logger?.warn({ err: error, instanceId: this.instance.id }, 'direct WhatsApp Web chat read failed');
      return null;
    }
  }

  /**
   * Read a bounded message window for one chat directly from the page.
   *
   * Uses the library's own injected helpers (WWebJS.getChat / loadEarlierMsgs)
   * but maps only primitive fields, so the `_serialized` -> `$1` rename that
   * breaks the model serialiser does not break the read.
   *
   * Returns an array of messages, `null` when the chat does not exist, or
   * `undefined` when the page is unavailable or the read failed (the caller
   * then falls back to the library API).
   */
  async #readMessagesFromStore(chatId, limit) {
    const page = this.#page();
    if (!page) return undefined;
    const selfId =
      this.client?.info?.wid?._serialized ??
      (this.client?.info?.wid?.user ? `${this.client.info.wid.user}@c.us` : null);
    try {
      return await page.evaluate(
        async (chatId, limit, selfId) => {
          const wid = window.require('WAWebWidFactory').createWid(chatId);
          const chat = window.require('WAWebCollections').Chat.get(wid);
          if (!chat) return null;
          const filter = (message) => !message.isNotification;
          let messages = chat.msgs?.getModelsArray?.()?.filter(filter) ?? [];
          if (limit > 0) {
            while (messages.length < limit) {
              let earlier = [];
              try {
                earlier = await window.require('WAWebChatLoadMessages').loadEarlierMsgs({ chat });
              } catch {
                break;
              }
              if (!earlier || earlier.length === 0) break;
              messages = [...earlier.filter(filter), ...messages];
            }
          }
          return messages.slice(-limit).map((message) => {
            const key = message.id || {};
            const id = key._serialized ?? key.$1 ?? null;
            const fromMe = Boolean(key.fromMe);
            const remote = key.remote?._serialized ?? (typeof key.remote === 'string' ? key.remote : null);
            return {
              id: { _serialized: id, id, fromMe },
              from: fromMe ? selfId : remote,
              to: fromMe ? remote : selfId,
              fromMe,
              type: message.type ?? 'unknown',
              body: typeof message.body === 'string' ? message.body : null,
              hasMedia: Boolean(message.isMedia ?? message.hasMedia),
              caption: typeof message.caption === 'string' ? message.caption : null,
              ack: message.ack ?? null,
              timestamp:
                typeof message.t === 'number' ? message.t : typeof message.timestamp === 'number' ? message.timestamp : null,
            };
          });
        },
        chatId,
        limit,
        selfId,
      );
    } catch (error) {
      this.logger?.warn({ err: error, instanceId: this.instance.id, chatId }, 'direct WhatsApp Web message read failed');
      return undefined;
    }
  }

  static validateChatId(chatId) {
    if (typeof chatId !== 'string' || !CHAT_ID_PATTERN.test(chatId)) {
      throw new ValidationError('"chatId" is not a valid WhatsApp chat id.', { field: 'chatId' });
    }
    return chatId;
  }

  async listChats({ limit = 25, cursor = null, since = null, until = null } = {}) {
    this.#assertReadyForData();
    // Prefer a direct store read: the library's own getChats() rejects on
    // current WhatsApp Web builds (see #readChatsFromStore). Fall back to the
    // library API when the page is unavailable.
    let rows;
    const fromStore = await this.#readChatsFromStore();
    if (fromStore) {
      rows = fromStore;
    } else {
      const chats = await this.#callLibrary('list chats', () => this.client.getChats());
      rows = chats.map(serialiseChat);
    }

    if (since) rows = rows.filter((chat) => chat.lastMessageAt && new Date(chat.lastMessageAt) >= new Date(since));
    if (until) rows = rows.filter((chat) => chat.lastMessageAt && new Date(chat.lastMessageAt) <= new Date(until));

    rows.sort(compareByLastMessageDesc);
    const total = rows.length;
    const filtered = cursor ? rows.filter((chat) => afterCursor(chat, cursor)) : rows;
    const window = filtered.slice(0, limit + 1);
    const hasMore = window.length > limit;
    const items = hasMore ? window.slice(0, limit) : window;

    return {
      items: items.slice(0, MAX_CHATS_SCAN),
      hasMore,
      limitations: [
        'Chats are read from the linked device on demand; nothing is scraped automatically.',
        since || until ? 'Date filters are applied to the last-message timestamp.' : 'No server-side date filter was applied.',
      ],
      total,
    };
  }

  async getChat(chatId) {
    this.#assertReadyForData();
    WebConnector.validateChatId(chatId);
    const fromStore = await this.#readChatsFromStore({ chatId, limit: 1 });
    if (fromStore && fromStore.length > 0) {
      return {
        ...fromStore[0],
        messagesAvailable: 'recent window only (connector limit)',
        limitations: ['Message history is limited to what the linked device can provide.'],
      };
    }
    const chat = await this.#callLibrary('read that chat', () => this.client.getChatById(chatId));
    if (!chat) return null;
    const serialised = serialiseChat(chat);
    return {
      ...serialised,
      messagesAvailable: 'recent window only (connector limit)',
      limitations: ['Message history is limited to what the linked device can provide.'],
    };
  }

  async listMessages(chatId, { limit = 25 } = {}) {
    this.#assertReadyForData();
    WebConnector.validateChatId(chatId);
    const fromStore = await this.#readMessagesFromStore(chatId, limit);
    if (Array.isArray(fromStore)) {
      return {
        items: fromStore.map((message) => serialiseMessage(message, chatId)),
        hasMore: false,
        nextCursor: null,
        limitations: [
          'whatsapp-web.js exposes a bounded recent window per chat; cursor pagination into older history is not supported by this connector.',
        ],
      };
    }
    if (fromStore === null) return null;
    const chat = await this.#callLibrary('read that chat', () => this.client.getChatById(chatId));
    if (!chat) return null;
    const messages = await this.#callLibrary('read messages for that chat', () => chat.fetchMessages({ limit }));
    return {
      items: messages.map((message) => serialiseMessage(message, chatId)),
      hasMore: false,
      nextCursor: null,
      limitations: [
        'whatsapp-web.js exposes a bounded recent window per chat; cursor pagination into older history is not supported by this connector.',
      ],
    };
  }

  async listContacts({ limit = 25, cursor = null } = {}) {
    this.#assertReadyForData();
    const contacts = await this.#callLibrary('list contacts', () => this.client.getContacts());
    const rows = contacts
      .slice(0, MAX_CONTACTS_SCAN)
      .map(serialiseContact)
      .sort((a, b) => String(a.contactId).localeCompare(String(b.contactId)));
    const filtered = cursor ? rows.filter((contact) => String(contact.contactId) > String(cursor.i)) : rows;
    const window = filtered.slice(0, limit + 1);
    const hasMore = window.length > limit;
    const items = hasMore ? window.slice(0, limit) : window;
    return {
      items,
      hasMore,
      limitations: [
        'Contacts come from the linked device and may be incomplete.',
        'Phone numbers are returned because this instance is authorised to read them.',
      ],
      total: rows.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* outbound messaging                                                  */
  /* ------------------------------------------------------------------ */

  /**
   * Send a text message using the linked device.
   *
   * This is not the official WhatsApp Business Platform: it sends as the linked
   * account. The status "sent" means the linked device handed the message to
   * WhatsApp; it is not an independent delivery confirmation.
   */
  async sendMessage({ to, text }) {
    this.#assertEnabled();
    this.#assertReadyForData();
    if (typeof this.client?.sendMessage !== 'function') {
      throw new CapabilityNotSupportedError('The installed whatsapp-web.js does not expose sendMessage().', {
        connector: this.type,
        operation: 'sendMessage',
      });
    }
    const chatId = normaliseWebChatId(to);
    const message = await this.#callLibrary('send a message', () => this.client.sendMessage(chatId, text));
    // Record the send immediately. `message_create` may also fire for it; the
    // provider-id de-duplication in #handleLibraryMessage keeps one row/event.
    await this.#handleLibraryMessage(message);
    return {
      status: 'sent',
      providerMessageId: message?.id?._serialized ?? message?.id?.id ?? null,
    };
  }

  /* ------------------------------------------------------------------ */
  /* teardown                                                           */
  /* ------------------------------------------------------------------ */

  async disconnect({ logout = false } = {}) {
    // Mark this as operator-initiated so a library 'disconnected' event raised
    // during teardown is not mistaken for an unexpected drop worth retrying.
    this.intentionalDisconnect = true;
    let sessionRevoked = false;
    if (logout && this.client?.logout) {
      try {
        await withTimeout(this.client.logout(), 20000, 'Timed out while logging out of WhatsApp Web.');
        sessionRevoked = true;
      } catch (error) {
        this.logger?.warn({ err: error, instanceId: this.instance.id }, 'logout attempt failed');
      }
    }

    await this.#teardownClient({ logout: false });

    if (logout) {
      await this.sessionService.destroySession(this.instance, { reason: 'logout' });
    }

    this.status = 'disconnected';
    this.mode = null;
    await this.events?.publish(this.instance.id, ConnectionEventType.DISCONNECTED, {
      status: this.status,
      connector: this.type,
      reason: logout ? 'logout' : 'disconnect',
      sessionRevoked,
      recoverable: false,
    });

    return { status: this.status, sessionRevoked };
  }

  /** Tear down any half-open client so a supervised reconnect starts clean. */
  async resetForReconnect() {
    this.intentionalDisconnect = false;
    await this.#teardownClient({ logout: false });
    this.status = 'created';
    this.mode = null;
  }

  async #teardownClient({ logout }) {
    this.#clearQr();
    clearTimeout(this.pairingTimer);
    this.pairingTimer = null;
    this.pairingWaiter = null;
    this.loading = null;
    this.authState = null;
    this.recentMessages = [];
    this.seenMessageIds.clear();
    const client = this.client;
    this.client = null;
    if (client) {
      try {
        if (logout && client.logout) await client.logout();
      } catch (error) {
        this.logger?.warn({ err: error, instanceId: this.instance.id }, 'client logout failed during teardown');
      }
    }
    await this.browserManager.release(this.instance.id, { destroy: true });
  }

  async destroy() {
    this.intentionalDisconnect = true;
    await this.#teardownClient({ logout: false });
    this.status = 'destroyed';
  }
}

/* ---------------------------------------------------------------------- */
/* mapping helpers — only fields the connector genuinely provides          */
/* ---------------------------------------------------------------------- */

/**
 * Turn a recipient into the full id whatsapp-web.js expects.
 *
 * A bare phone number is treated as a user id; a caller that already supplied a
 * chat id (for example `131355503402@c.us`, or a LID-based `...@lid`) is passed
 * through unchanged. Rewriting a LID to `@c.us` addresses the wrong chat.
 */
export function normaliseWebChatId(to) {
  const value = String(to ?? '').trim();
  return value.includes('@') ? value : `${value}@c.us`;
}

export function serialiseChat(chat) {
  const id = chat.id?._serialized ?? (typeof chat.id === 'string' ? chat.id : null);
  return {
    chatId: id,
    displayName: chat.name ?? null,
    isGroup: Boolean(chat.isGroup),
    unreadCount: typeof chat.unreadCount === 'number' ? chat.unreadCount : 0,
    archived: Boolean(chat.archived),
    pinned: Boolean(chat.pinned),
    isMuted: Boolean(chat.isMuted),
    lastMessageAt: chat.timestamp ? new Date(chat.timestamp * 1000) : null,
    source: 'whatsapp_web',
  };
}

export function serialiseMessage(message, chatId) {
  const hasMedia = Boolean(message.hasMedia);
  const fromMe = Boolean(message.fromMe);
  return {
    id: message.id?._serialized ?? message.id?.id ?? null,
    chatId,
    direction: fromMe ? 'outbound' : 'inbound',
    from: message.from ?? null,
    to: message.to ?? null,
    fromMe,
    type: message.type ?? 'unknown',
    body: typeof message.body === 'string' ? message.body : null,
    hasMedia,
    caption: typeof message.caption === 'string' ? message.caption : null,
    ack: message.ack ?? null,
    timestamp: message.timestamp ? new Date(message.timestamp * 1000) : null,
    source: 'whatsapp_web',
  };
}

export function serialiseContact(contact) {
  return {
    contactId: contact.id?._serialized ?? (typeof contact.id === 'string' ? contact.id : null),
    name: contact.name ?? null,
    pushname: contact.pushname ?? null,
    shortName: contact.shortName ?? null,
    number: contact.number ?? null,
    isBusiness: Boolean(contact.isBusiness),
    isEnterprise: Boolean(contact.isEnterprise),
    isMyContact: Boolean(contact.isMyContact),
    source: 'whatsapp_web',
  };
}

function compareByLastMessageDesc(a, b) {
  const at = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
  const bt = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
  if (at !== bt) return bt - at;
  return String(b.chatId).localeCompare(String(a.chatId));
}

function afterCursor(row, cursor) {
  const t = row.lastMessageAt ? new Date(row.lastMessageAt).getTime() : 0;
  if (t < cursor.t) return true;
  if (t > cursor.t) return false;
  return String(row.chatId) < String(cursor.i);
}
