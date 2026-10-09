import { createHash } from 'crypto';

/** The exact JSON text stored in `crypto_raw_records.payload`. */
export const serializePayload = (payload: unknown): string =>
  JSON.stringify(payload);

/**
 * sha256 (hex) of the serialized payload. Shared by the sync engine and the
 * CSV importer so a record has the same `payload_hash` whichever path wrote it.
 */
export const computePayloadHash = (payload: unknown): string =>
  createHash('sha256').update(serializePayload(payload)).digest('hex');
