import { Global, Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { EnvironmentVariables } from '../config/env.validation.js';
import { FILE_STORAGE, type FileStorage } from './file-storage.js';
import { LocalFileStorage } from './local-file-storage.js';
import { createS3Client, S3FileStorage } from './s3-file-storage.js';

/**
 * Almacenamiento privado de archivos según `STORAGE_DRIVER`. La validación
 * de entorno ya impide `local` en producción y exige bucket y región para `s3`.
 */
@Global()
@Module({
  providers: [
    {
      provide: FILE_STORAGE,
      inject: [ConfigService],
      useFactory: (
        config: ConfigService<EnvironmentVariables, true>,
      ): FileStorage => {
        const logger = new Logger('FileStorage');
        if (config.get('STORAGE_DRIVER', { infer: true }) === 's3') {
          logger.log('Almacenamiento de objetos S3 (bucket privado)');
          return new S3FileStorage(
            createS3Client({
              bucket: config.get('STORAGE_S3_BUCKET', { infer: true })!,
              region: config.get('STORAGE_S3_REGION', { infer: true })!,
              endpoint: config.get('STORAGE_S3_ENDPOINT', { infer: true }),
              accessKeyId: config.get('STORAGE_S3_ACCESS_KEY_ID', {
                infer: true,
              }),
              secretAccessKey: config.get('STORAGE_S3_SECRET_ACCESS_KEY', {
                infer: true,
              }),
              forcePathStyle: config.get('STORAGE_S3_FORCE_PATH_STYLE', {
                infer: true,
              }),
            }),
            config.get('STORAGE_S3_BUCKET', { infer: true })!,
          );
        }
        // Sin la ruta en el log: solo se indica el modo.
        logger.warn(
          'Almacenamiento LOCAL (solo desarrollo y pruebas; no persiste en Render)',
        );
        return new LocalFileStorage(
          config.get('STORAGE_LOCAL_PATH', { infer: true }),
        );
      },
    },
  ],
  exports: [FILE_STORAGE],
})
export class StorageModule {}
