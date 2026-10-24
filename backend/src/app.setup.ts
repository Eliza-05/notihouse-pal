import { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { EnvironmentVariables } from './config/env.validation.js';

export const API_PREFIX = 'api/v1';
export const SWAGGER_PATH = 'api/docs';

/**
 * Configuración HTTP compartida por main.ts y las pruebas e2e,
 * para que ambas ejerciten la misma aplicación.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<EnvironmentVariables, true>);

  app.setGlobalPrefix(API_PREFIX);
  app.enableCors({ origin: config.get('FRONTEND_URL', { infer: true }) });

  // Swagger no se expone en producción hasta contar con protección.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('NotiHouse-Pal API')
        .setDescription('API REST del backend de NotiHouse-Pal')
        .setVersion('0.1.0')
        .build(),
    );
    SwaggerModule.setup(SWAGGER_PATH, app, document);
  }
}
