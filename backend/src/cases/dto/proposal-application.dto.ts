import { ApiProperty } from '@nestjs/swagger';
import { OBLIGATION_STATUSES } from '../../obligations/dto/obligation.dto.js';
import { OCCURRENCE_STATUSES } from '../../obligations/dto/occurrence.dto.js';
import { RENTAL_STATUSES } from '../../rentals/dto/rental.dto.js';
import { PROPOSAL_ACTIONS, type ProposalAction } from '../proposal-actions.js';

/**
 * Cuerpo vacío: los datos aplicados son exclusivamente los de la propuesta
 * aprobada. Cualquier campo enviado se rechaza (no se aceptan correcciones
 * libres del cliente).
 */
export class ApplyProposalDto {}

/**
 * El recurso de la aplicación (exactamente uno, ver D8): un período
 * (acciones sobre períodos), una obligación sin período propio
 * (`update_obligation_schedule`, `create_recurring_obligation`) o un
 * arriendo (`create_recurring_rental`).
 */
export class AppliedResourceDto {
  @ApiProperty({ enum: ['obligation_occurrence', 'obligation', 'rental'] })
  type: 'obligation_occurrence' | 'obligation' | 'rental';

  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: '`null` cuando el recurso es un arriendo',
  })
  obligationId: string | null;

  @ApiProperty({
    enum: [...OCCURRENCE_STATUSES, ...OBLIGATION_STATUSES, ...RENTAL_STATUSES],
    description: 'Estado actual del recurso aplicado',
  })
  status: string;
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
      'Obligación creada por la acción (create_obligation_with_occurrence o create_recurring_obligation)',
  })
  createdObligationId: string | null;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description: 'Arriendo creado por la acción (solo create_recurring_rental)',
  })
  createdRentalId: string | null;

  @ApiProperty({ format: 'uuid', description: 'correlation_id del caso' })
  correlationId: string;
}
