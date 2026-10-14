import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ClsMiddleware } from 'nestjs-cls';
import * as path from 'path';
import './utils/moment-mysql';
import { AppModule } from './modules/App/App.module';
import { NestExpressApplication } from '@nestjs/platform-express';
import { securityHeaders } from './common/middleware/securityHeaders';

global.__public_dirname = path.join(__dirname, '..', 'public');
global.__static_dirname = path.join(__dirname, '../static');
global.__views_dirname = path.join(global.__static_dirname, '/views');
global.__images_dirname = path.join(global.__static_dirname, '/images');

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
  });
  app.set('query parser', 'extended');
  // Behind a reverse proxy (Caddy) the socket peer is the proxy, so trust its
  // X-Forwarded-For for req.ip (used by the throttler). Hops = trusted proxies
  // in front of the API; 0 (default) disables it.
  const trustProxyHops = parseInt(process.env.TRUST_PROXY_HOPS ?? '0', 10);
  if (trustProxyHops > 0) {
    app.set('trust proxy', trustProxyHops);
  }
  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.setGlobalPrefix('/api');

  // create and mount the middleware manually here
  app.use(new ClsMiddleware({}).use);

  const config = new DocumentBuilder()
    .setTitle('Bigcapital')
    .setDescription('Financial accounting software')
    .setVersion('1.0')
    .build();

  const documentFactory = () => SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('swagger', app, documentFactory);

  await app.listen(process.env.PORT ?? 3000);
}
bootstrap();
