import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { AppModule } from './app.module.js';
import { configureApp } from './app.setup.js';
import { EnvironmentVariables } from './config/env.validation.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  configureApp(app);
  // Cierra el pool de PostgreSQL al recibir SIGTERM (Render) o SIGINT.
  app.enableShutdownHooks();

  const config = app.get(ConfigService<EnvironmentVariables, true>);
  // 0.0.0.0 permite recibir tráfico externo al contenedor (p. ej. en Render).
  await app.listen(config.get('PORT', { infer: true }), '0.0.0.0');
}
await bootstrap();
