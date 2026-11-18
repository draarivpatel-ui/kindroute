/**
 * Zero-server encrypted dispatch card codec.
 *
 * A single volunteer's route card is encrypted locally with AES-256-GCM using
 * a random 96-bit IV and encoded as compact base64url. The shareable URL
 * fragment `#card=<ciphertext>&k=<key>` carries both ciphertext and key, so
 * no backend database is required and no plaintext PII is stored in transit.
 *
 * Uses only the standard Web Crypto API (globalThis.crypto.subtle), available
 * in Node 20+ and all modern browsers. No dependencies, no Node-only imports.
 */

const IV_BYTES = 12;
const KEY_BYTES = 32;
const MIN_CARD_LENGTH = 40;

function getCrypto() {
  const crypto = globalThis.crypto;
  if (!crypto || !crypto.subtle) {
    throw new Error('Web Crypto API unavailable; use Node 20+ or a modern browser');
  }
  return crypto;
}

function toBase64Url(bytes) {
  let binary = '';
  const view = new Uint8Array(bytes);
  for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function fromBase64Url(text) {
  if (typeof text !== 'string' || text.length === 0) throw new TypeError('base64url input must be a nonempty string');
  if (!/^[A-Za-z0-9_-]+$/.test(text)) throw new TypeError('base64url input contains invalid characters');
  const padded = text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
  return out;
}

function encodeUtf8(text) {
  return new TextEncoder().encode(text);
}

function decodeUtf8(bytes) {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

/** Generate a fresh 256-bit AES-GCM key as a base64url string. */
export async function generateKey() {
  const key = await getCrypto().subtle.generateKey({ name: 'AES-GCM', length: KEY_BYTES * 8 }, true, ['encrypt', 'decrypt']);
  const raw = await getCrypto().subtle.exportKey('raw', key);
  return toBase64Url(raw);
}

/**
 * Encrypt and serialize a dispatch card.
 *
 * @param {object} card any JSON-serializable volunteer route card
 * @param {string} [keyBase64Url] optional existing key; a fresh one is generated if omitted
 * @returns {Promise<{ciphertext:string, key:string, fragment:string, bytes:number}>}
 */
export async function encryptCard(card, keyBase64Url) {
  if (card == null || typeof card !== 'object' || Array.isArray(card)) {
    throw new TypeError('card must be a plain object');
  }
  const keyText = keyBase64Url ?? (await generateKey());
  const rawKey = fromBase64Url(keyText);
  if (rawKey.length !== KEY_BYTES) throw new TypeError(`key must decode to ${KEY_BYTES} bytes`);

  const crypto = getCrypto();
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  let plaintext;
  try {
    plaintext = encodeUtf8(JSON.stringify(card));
  } catch (error) {
    throw new TypeError(`card is not JSON-serializable: ${error.message}`);
  }
  const buffer = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext);
  const packed = new Uint8Array(IV_BYTES + buffer.byteLength);
  packed.set(iv, 0);
  packed.set(new Uint8Array(buffer), IV_BYTES);
  const ciphertext = toBase64Url(packed);
  return {
    ciphertext,
    key: keyText,
    fragment: `#card=${ciphertext}&k=${keyText}`,
    bytes: packed.length,
  };
}

/**
 * Decrypt a dispatch card. Authentication failure (wrong key or any bit flip)
 * rejects with a clean Error whose message is 'Authentication failed'.
 *
 * @param {string} ciphertext base64url IV+tag+ciphertext blob
 * @param {string} keyBase64Url base64url 256-bit key
 * @returns {Promise<object>} the original card object
 */
export async function decryptCard(ciphertext, keyBase64Url) {
  if (typeof ciphertext !== 'string' || ciphertext.length < MIN_CARD_LENGTH) {
    throw new TypeError('ciphertext is too short');
  }
  const packed = fromBase64Url(ciphertext);
  if (packed.length <= IV_BYTES) throw new TypeError('ciphertext is missing authentication tag');
  const rawKey = fromBase64Url(keyBase64Url);
  if (rawKey.length !== KEY_BYTES) throw new TypeError(`key must decode to ${KEY_BYTES} bytes`);

  const crypto = getCrypto();
  const key = await crypto.subtle.importKey('raw', rawKey, { name: 'AES-GCM' }, true, ['encrypt', 'decrypt']);
  const iv = packed.subarray(0, IV_BYTES);
  const data = packed.subarray(IV_BYTES);
  let plaintext;
  try {
    plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
  } catch {
    throw new Error('Authentication failed');
  }
  try {
    const card = JSON.parse(decodeUtf8(new Uint8Array(plaintext)));
    if (card == null || typeof card !== 'object' || Array.isArray(card)) {
      throw new TypeError('decrypted payload is not an object');
    }
    return card;
  } catch (error) {
    throw new Error(`Invalid card payload: ${error.message}`);
  }
}

/**
 * Encode a full shareable URL from a card.
 *
 * @param {string} baseUrl e.g. https://example.org/
 * @param {{ciphertext:string, key:string}} encrypted result of encryptCard
 */
export function buildShareUrl(baseUrl, encrypted) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) throw new TypeError('baseUrl must be a string');
  return `${baseUrl}#card=${encrypted.ciphertext}&k=${encrypted.key}`;
}

/** Parse a `#card=...&k=...` fragment into its two components. */
export function parseShareFragment(fragmentInput) {
  const fragment = typeof fragmentInput === 'string' && fragmentInput.startsWith('#')
    ? fragmentInput.slice(1)
    : fragmentInput;
  if (typeof fragment !== 'string') throw new TypeError('fragment must be a string');
  const params = new URLSearchParams(fragment);
  const card = params.get('card');
  const key = params.get('k');
  if (!card || !key) throw new TypeError('fragment must contain card and k parameters');
  return { ciphertext: card, key };
}

export default { generateKey, encryptCard, decryptCard, buildShareUrl, parseShareFragment };
