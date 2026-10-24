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
