import { registerAs } from '@nestjs/config';

/** The model that reads receipts unless `ANTHROPIC_MODEL` names another. */
export const DEFAULT_RECEIPT_MODEL = 'claude-opus-5';

/**
 * Claude API access for reading receipts. The key comes only from the
 * environment; without it, receipt autofill is switched off and the rest of the
 * app is unaffected.
 */
export default registerAs('anthropic', () => ({
  apiKey: process.env.ANTHROPIC_API_KEY || undefined,
  model: process.env.ANTHROPIC_MODEL || DEFAULT_RECEIPT_MODEL,
}));
