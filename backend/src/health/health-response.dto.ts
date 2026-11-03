import { ApiProperty } from '@nestjs/swagger';

export class HealthResponseDto {
  @ApiProperty({ type: String, example: 'ok' })
  status: 'ok';

  @ApiProperty({ type: String, example: 'notihouse-pal-api' })
  service: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-10-24T19:00:00.000Z',
    description: 'Fecha y hora de la respuesta en ISO 8601 (UTC).',
  })
  timestamp: string;
}

export class ReadinessChecksDto {
  @ApiProperty({ enum: ['ok', 'unavailable'] })
  database: 'ok' | 'unavailable';
}

export class ReadinessResponseDto {
  @ApiProperty({ enum: ['ready', 'unavailable'] })
  status: 'ready' | 'unavailable';

  @ApiProperty({ type: String, example: 'notihouse-pal-api' })
  service: string;

  @ApiProperty({ type: ReadinessChecksDto })
  checks: ReadinessChecksDto;

  @ApiProperty({ type: String, format: 'date-time' })
  timestamp: string;
}
