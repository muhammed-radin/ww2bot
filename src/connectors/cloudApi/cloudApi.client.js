/**
 * Minimal Meta Graph API client for the WhatsApp Business Platform.
 *
 * Only the documented endpoints this gateway needs are implemented: credential
 * verification and sending a plain text message. Errors are mapped to a safe
 * subset of Meta's error payload; raw provider responses are never returned to
 * API clients.
 */
import { ProviderError } from '../../utils/errors.js';

const DEFAULT_TIMEOUT_MS = 10000;

export class CloudApiClient {
  constructor({ accessToken, phoneNumberId, apiVersion, baseUrl, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS, logger }) {
    this.accessToken = accessToken;
    this.phoneNumberId = phoneNumberId;
    this.apiVersion = apiVersion;
    this.baseUrl = baseUrl;
    this.timeoutMs = timeoutMs;
    this.logger = logger;
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    if (typeof this.fetchImpl !== 'function') {
      throw new ProviderError('No fetch implementation is available for the Cloud API client.');
    }
  }

  get configured() {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  #url(path) {
    return `${this.baseUrl.replace(/\/$/, '')}/${this.apiVersion}/${path.replace(/^\//, '')}`;
  }

  async #request(path, { method = 'GET', query, body } = {}) {
    const url = new URL(this.#url(path));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (error) {
      this.logger?.warn({ err: error, endpoint: path }, 'cloud api request failed');
      throw new ProviderError('The WhatsApp Cloud API could not be reached.', { endpoint: path });
    } finally {
      clearTimeout(timer);
    }

    const text = await response.text();
    let payload = null;
    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = null;
      }
    }

    if (!response.ok) {
      const providerError = payload?.error ?? null;
      throw new ProviderError('The WhatsApp Cloud API returned an error.', {
        endpoint: path,
        status: response.status,
        // Safe subset only: never echo the access token or the raw body.
        providerCode: providerError?.code ?? null,
        providerType: providerError?.type ?? null,
        providerMessage: typeof providerError?.message === 'string' ? providerError.message.slice(0, 300) : null,
      });
    }

    return payload;
  }

  /** Verify credentials and return the configured business phone number details. */
  async getPhoneNumber() {
    if (!this.configured) {
      throw new ProviderError('The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).');
    }
    const payload = await this.#request(this.phoneNumberId, {
      query: { fields: 'id,display_phone_number,verified_name,quality_rating,platform_type' },
    });
    return {
      id: payload?.id ?? this.phoneNumberId,
      displayPhoneNumber: payload?.display_phone_number ?? null,
      verifiedName: payload?.verified_name ?? null,
      qualityRating: payload?.quality_rating ?? null,
      platformType: payload?.platform_type ?? null,
    };
  }

  /**
   * Send a text message. Returns Meta's message id when accepted.
   *
   * "Accepted" is all the API confirms at this point: it is NOT proof that the
   * message reached the handset. Delivery status arrives later via webhooks.
   */
  async sendTextMessage({ to, text }) {
    if (!this.configured) {
      throw new ProviderError('The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).');
    }
    const payload = await this.#request(`${this.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'text',
        text: { preview_url: false, body: text },
      },
    });
    const messageId = payload?.messages?.[0]?.id ?? null;
    return {
      providerMessageId: messageId,
      // Meta returns 200/201 with a wamid when the request is accepted.
      status: messageId ? 'accepted' : 'unknown',
    };
  }
}
