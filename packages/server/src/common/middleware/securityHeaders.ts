import type { NextFunction, Request, Response } from 'express';

/**
 * Express middleware that sets baseline hardening headers on every response.
 * - X-Content-Type-Options: nosniff (browsers must honour declared types).
 * Pair with `app.disable('x-powered-by')` at bootstrap.
 */
export function securityHeaders(
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
}
