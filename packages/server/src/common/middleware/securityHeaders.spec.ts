import * as http from 'http';
import { AddressInfo } from 'net';
import * as express from 'express';
import { securityHeaders } from './securityHeaders';

describe('securityHeaders', () => {
  let server: http.Server;
  let port: number;

  beforeAll(async () => {
    const app = express();
    app.disable('x-powered-by');
    app.use(securityHeaders);
    app.get('/ok', (_req, res) => {
      res.json({ ok: true });
    });
    app.get('/pdf', (_req, res) => {
      res.setHeader('Content-Type', 'application/pdf');
      res.send(Buffer.from('%PDF-1.4'));
    });
    server = await new Promise<http.Server>((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    port = (server.address() as AddressInfo).port;
  });

  afterAll(async () => {
    await new Promise((resolve) => server.close(resolve));
  });

  const get = (path: string) =>
    new Promise<http.IncomingMessage>((resolve, reject) => {
      http
        .get({ host: '127.0.0.1', port, path }, (res) => {
          res.resume();
          res.on('end', () => resolve(res));
        })
        .on('error', reject);
    });

  it('sets nosniff and omits X-Powered-By on JSON responses', async () => {
    const res = await get('/ok');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['x-powered-by']).toBeUndefined();
  });

  it('keeps explicit content types on file responses', async () => {
    const res = await get('/pdf');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['content-type']).toContain('application/pdf');
  });
});
