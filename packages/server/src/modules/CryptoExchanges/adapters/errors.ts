/** Base class for exchange adapter failures. Messages never contain credentials. */
export class ExchangeError extends Error {
  readonly userMessage: string;
  readonly retryable: boolean;

  constructor(message: string, userMessage: string, retryable: boolean) {
    super(message);
    this.name = new.target.name;
    this.userMessage = userMessage;
    this.retryable = retryable;
  }
}

/** Key rejected, signature invalid, or key lacks the permission required. */
export class ExchangeAuthError extends ExchangeError {
  constructor(
    message = 'Exchange rejected the API credentials',
    userMessage = 'The exchange rejected this API key. Check the key, secret and permissions.',
  ) {
    super(message, userMessage, false);
  }
}

export class ExchangeRateLimitError extends ExchangeError {
  /** Wait requested by the exchange (Retry-After), when it sent one. */
  readonly retryAfterMs?: number;

  constructor(
    message = 'Exchange rate limit exceeded',
    userMessage = 'The exchange is rate limiting requests. The sync will retry shortly.',
    retryAfterMs?: number,
  ) {
    super(message, userMessage, true);
    this.retryAfterMs = retryAfterMs;
  }
}

export class ExchangeNetworkError extends ExchangeError {
  constructor(
    message = 'Could not reach the exchange',
    userMessage = 'Could not reach the exchange. The sync will retry shortly.',
    retryable = true,
  ) {
    super(message, userMessage, retryable);
  }
}

/** Response did not have the documented shape. Carries the raw body for storage. */
export class ExchangeSchemaError extends ExchangeError {
  /** Redacted parsed JSON when the body parsed, otherwise the (truncated) raw text. */
  readonly rawBody: unknown;

  constructor(
    message: string,
    rawBody: unknown,
    userMessage = 'The exchange returned data in an unexpected format.',
  ) {
    super(message, userMessage, false);
    this.rawBody = rawBody;
  }
}

/** The key can do more than read (trade, withdraw, ...); we refuse to store it. */
export class KeyHasExtraPermissionsError extends ExchangeError {
  readonly permissions: string[];

  constructor(permissions: string[] = []) {
    super(
      'API key has permissions beyond read-only',
      'This API key can do more than read data (for example trade or withdraw). Create a read-only key and try again.',
      false,
    );
    this.permissions = permissions;
  }
}
