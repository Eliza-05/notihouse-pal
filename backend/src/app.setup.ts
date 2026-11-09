import { INestApplication, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { CORRELATION_HEADER } from './common/correlation-id.decorator.js';
import { DatabaseExceptionFilter } from './common/database-exception.filter.js';
import { EnvironmentVariables } from './config/env.validation.js';

export const API_PREFIX = 'api/v1';
export const SWAGGER_PATH = 'api/docs';
/** Métodos y cabeceras que usa realmente el frontend. */
export const CORS_METHODS = ['GET', 'POST', 'PATCH'];
export const CORS_ALLOWED_HEADERS = [
  'Authorization',
  'Content-Type',
  CORRELATION_HEADER,
];

/**
 * Configuración HTTP compartida por main.ts y las pruebas e2e,
 * para que ambas ejerciten la misma aplicación.
 */
export function configureApp(app: INestApplication): void {
  const config = app.get(ConfigService<EnvironmentVariables, true>);

  app.setGlobalPrefix(API_PREFIX);
  // Datos privados por usuario: ningún navegador ni proxy debe guardarlos.
  // Evita que, tras cerrar sesión o cambiar de cuenta, una consulta periódica
  // (alertas, bandeja) muestre respuestas de otra sesión. Las descargas fijan
  // después su propia cabecera ('private, no-store').
  app.use(
    (
      _req: unknown,
      res: { setHeader(k: string, v: string): void },
      next: () => void,
    ) => {
      res.setHeader('Cache-Control', 'no-store');
      next();
    },
  );
  // IP del cliente detrás de un proxy inverso: solo se confía en el número
  // exacto de saltos configurado (0 por defecto: se ignora X-Forwarded-For).
  const trustProxyHops = config.get('TRUST_PROXY_HOPS', { infer: true });
  if (trustProxyHops > 0) {
    (
      app.getHttpAdapter().getInstance() as { set(k: string, v: unknown): void }
    ).set('trust proxy', trustProxyHops);
  }
  // Lista explícita de orígenes permitidos (D18): el frontend local y, si se
  // configuran, los de Vercel. Sin cookies: la sesión viaja en la cabecera
  // Authorization, por lo que no se habilitan credenciales.
  const allowedOrigins = config.get('FRONTEND_URLS', { infer: true });
  app.enableCors({
    origin(
      origin: string | undefined,
      callback: (error: Error | null, allow?: boolean) => void,
    ) {
      // Sin cabecera Origin (curl, health checks): no es una petición CORS.
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
        return;
      }
      // Origen no autorizado: no se emiten cabeceras CORS (el navegador
      // bloquea la respuesta) y la petición sigue su curso sin error 500.
      callback(null, false);
    },
    methods: CORS_METHODS,
    allowedHeaders: CORS_ALLOWED_HEADERS,
    exposedHeaders: [CORRELATION_HEADER],
    credentials: false,
    maxAge: 600,
  });
  // Rechaza propiedades no declaradas en los DTO (p. ej. un ownerId enviado por el cliente).
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  // Traduce errores conocidos de PostgreSQL a 400/409/503 sin exponer detalles internos.
  app.useGlobalFilters(new DatabaseExceptionFilter(app.getHttpAdapter()));

  // Swagger no se expone en producción hasta contar con protección.
  if (config.get('NODE_ENV', { infer: true }) !== 'production') {
    const document = SwaggerModule.createDocument(
      app,
      new DocumentBuilder()
        .setTitle('NotiHouse-Pal API')
        .setDescription('API REST del backend de NotiHouse-Pal')
        .setVersion('0.1.0')
        .addBearerAuth()
        .addBearerAuth(
          {
            type: 'http',
            scheme: 'bearer',
            description:
              'Token del servicio de automatización (N8N_SERVICE_TOKEN). Solo rutas /internal.',
          },
          'service',
        )
        .build(),
    );
    SwaggerModule.setup(SWAGGER_PATH, app, document);
  }
}
