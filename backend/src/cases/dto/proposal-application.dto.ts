import { ApiProperty } from '@nestjs/swagger';
import { OCCURRENCE_STATUSES } from '../../obligations/dto/occurrence.dto.js';
import { PROPOSAL_ACTIONS, type ProposalAction } from '../proposal-actions.js';

/**
 * Cuerpo vacío: los datos aplicados son exclusivamente los de la propuesta
 * aprobada. Cualquier campo enviado se rechaza (no se aceptan correcciones
 * libres del cliente).
 */
export class ApplyProposalDto {}

export class AppliedResourceDto {
  @ApiProperty({ enum: ['obligation_occurrence'] })
  type: 'obligation_occurrence';

  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({ format: 'uuid' })
  obligationId: string;

  @ApiProperty({
    enum: OCCURRENCE_STATUSES,
    description:
      'Estado actual del período. Se crea siempre `pending`: aplicar no registra pagos.',
  })
  status: (typeof OCCURRENCE_STATUSES)[number];
}

export class ProposalApplicationResponseDto {
  @ApiProperty({ format: 'uuid' })
  caseId: string;

  @ApiProperty({ format: 'uuid' })
  proposalId: string;

  @ApiProperty({ example: 2 })
  proposalVersion: number;

  @ApiProperty({
    format: 'uuid',
    description: 'Revisión humana que lo autorizó',
  })
  hitlRequestId: string;

  @ApiProperty({ enum: PROPOSAL_ACTIONS })
  action: ProposalAction;

  @ApiProperty({ enum: ['applied'] })
  status: 'applied';

  @ApiProperty({
    description: 'true si ya se había aplicado antes (respuesta idempotente)',
  })
  alreadyApplied: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  appliedAt: Date;

  @ApiProperty({ type: AppliedResourceDto })
  resource: AppliedResourceDto;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'Obligación creada por la acción (solo create_obligation_with_occurrence)',
  })
  createdObligationId: string | null;

  @ApiProperty({ format: 'uuid', description: 'correlation_id del caso' })
  correlationId: string;
}
