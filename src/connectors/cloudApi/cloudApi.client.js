/**
 * Minimal Meta Graph API client for the WhatsApp Business Platform.
 *
 * Only the documented endpoints this gateway needs are implemented: credential
 * verification, media upload, and typed sends for text, media, location,
 * contacts and reactions. Errors are mapped to a safe subset of Meta's error
 * payload; raw provider responses are never returned to API clients.
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

  async #request(path, { method = 'GET', query, body, timeoutMs = this.timeoutMs } = {}) {
    const url = new URL(this.#url(path));
    for (const [key, value] of Object.entries(query ?? {})) {
      if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    }

    const isFormData = typeof FormData !== 'undefined' && body instanceof FormData;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let response;
    try {
      response = await this.fetchImpl(url, {
        method,
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          Accept: 'application/json',
          ...(body && !isFormData ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? (isFormData ? body : JSON.stringify(body)) : undefined,
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

  /** Upload base64 media to Meta and return its media id. */
  async uploadMedia({ data, mimetype, filename }) {
    if (!this.configured) {
      throw new ProviderError('The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).');
    }
    if (typeof FormData === 'undefined' || typeof Blob === 'undefined') {
      throw new ProviderError('This Node.js runtime cannot build a multipart media upload.');
    }
    const bytes = Buffer.from(String(data ?? ''), 'base64');
    if (bytes.length === 0) throw new ProviderError('The media payload is empty.');
    const form = new FormData();
    form.append('messaging_product', 'whatsapp');
    form.append('type', mimetype);
    form.append('file', new Blob([bytes], { type: mimetype }), filename || 'upload');
    const payload = await this.#request(`${this.phoneNumberId}/media`, {
      method: 'POST',
      body: form,
      // Media uploads legitimately take longer than a JSON request.
      timeoutMs: Math.max(this.timeoutMs, 60000),
    });
    return payload?.id ?? null;
  }

  /** Send an image, video, audio, document or sticker by uploaded media id. */
  async sendMediaMessage({ to, type, media, caption, filename, voice, asDocument, asSticker, replyToMessageId }) {
    if (!this.configured) {
      throw new ProviderError('The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).');
    }
    if (!media?.mimetype || !media?.data) throw new ProviderError('A media message requires a MIME type and data.');
    const mediaId = await this.uploadMedia({
      data: media.data,
      mimetype: media.mimetype,
      filename: media.filename ?? filename,
    });
    if (!mediaId) throw new ProviderError('The Cloud API did not return a media id.');
    const kind = type === 'audio' || voice ? 'audio' : (asSticker ? 'sticker' : type);
    const payload = {
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to,
      type: kind,
      [kind]: {
        id: mediaId,
        // Meta's audio object uses `voice: true` for a voice note.
        ...(kind === 'audio' && voice ? { voice: true } : {}),
        ...(caption && kind !== 'audio' && kind !== 'sticker' ? { caption } : {}),
        ...(kind === 'document' && (filename || media.filename) ? { filename: filename || media.filename } : {}),
      },
      ...(replyToMessageId ? { context: { message_id: replyToMessageId } } : {}),
    };
    const response = await this.#request(`${this.phoneNumberId}/messages`, { method: 'POST', body: payload });
    const messageId = response?.messages?.[0]?.id ?? null;
    return {
      providerMessageId: messageId,
      status: messageId ? 'accepted' : 'unknown',
      type: kind,
    };
  }

  async sendLocationMessage({ to, location }) {
    if (!this.configured) {
      throw new ProviderError('The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).');
    }
    const payload = await this.#request(`${this.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'location',
        location: {
          latitude: location.latitude,
          longitude: location.longitude,
          ...(location.name ? { name: location.name } : {}),
          ...(location.address ? { address: location.address } : {}),
        },
      },
    });
    const messageId = payload?.messages?.[0]?.id ?? null;
    return { providerMessageId: messageId, status: messageId ? 'accepted' : 'unknown', type: 'location' };
  }

  async sendContactMessage({ to, contact }) {
    if (!this.configured) {
      throw new ProviderError('The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).');
    }
    if (!contact?.phone) throw new ProviderError('A contact message requires a phone number.');
    const payload = await this.#request(`${this.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'contacts',
        contacts: [
          {
            name: {
              formatted_name: contact.name || contact.phone,
              first_name: contact.name || contact.phone,
            },
            phones: [{ phone: contact.phone, type: 'CELL', wa_id: String(contact.phone).replace(/\D/g, '') }],
            ...(contact.organization ? { org: { company: contact.organization } } : {}),
          },
        ],
      },
    });
    const messageId = payload?.messages?.[0]?.id ?? null;
    return { providerMessageId: messageId, status: messageId ? 'accepted' : 'unknown', type: 'contact' };
  }

  async sendReactionMessage({ to, messageId, reaction }) {
    if (!this.configured) {
      throw new ProviderError('The Cloud API connector is not configured (META_ACCESS_TOKEN / META_PHONE_NUMBER_ID).');
    }
    const payload = await this.#request(`${this.phoneNumberId}/messages`, {
      method: 'POST',
      body: {
        messaging_product: 'whatsapp',
        recipient_type: 'individual',
        to,
        type: 'reaction',
        reaction: { message_id: messageId, emoji: reaction ?? '' },
      },
    });
    const id = payload?.messages?.[0]?.id ?? null;
    return { providerMessageId: id, status: id ? 'accepted' : 'unknown', type: 'reaction' };
  }
}
