import { ApiProperty } from '@nestjs/swagger';

export class PropertyCountsDto {
  @ApiProperty() total: number;
  @ApiProperty() active: number;
}

export class ObligationCountsDto {
  @ApiProperty({ description: 'Obligaciones (definiciones) activas' })
  active: number;
  @ApiProperty({ description: 'Períodos abiertos que aún no vencen' })
  periodsPending: number;
  @ApiProperty({ description: 'Períodos abiertos con fecha vencida' })
  periodsOverdue: number;
  @ApiProperty({
    description: 'Períodos abiertos dentro del umbral (incluye hoy)',
  })
  periodsDueSoon: number;
  @ApiProperty({
    description: 'Períodos confirmados por el usuario (paid/attended)',
  })
  periodsConfirmed: number;
}

export class RentChargeCountsDto {
  @ApiProperty({ description: 'Cobros abiertos que aún no vencen' })
  pending: number;
  @ApiProperty({ description: 'Cobros abiertos con fecha vencida' })
  overdue: number;
  @ApiProperty({
    description: 'Cobros abiertos dentro del umbral (incluye hoy)',
  })
  dueSoon: number;
  @ApiProperty({
    description: 'Cobros con recepción confirmada por el usuario',
  })
  received: number;
}

export class ContractCountsDto {
  @ApiProperty() active: number;
  @ApiProperty({ description: 'Activos que finalizan dentro del umbral' })
  endingSoon: number;
  @ApiProperty({ description: 'Activos con fecha de finalización superada' })
  endPassed: number;
}

export class PendingCountDto {
  @ApiProperty() pending: number;
}

export class AlertCountsDto {
  @ApiProperty({ description: 'Alertas vigentes' }) active: number;
  @ApiProperty({ description: 'Alertas vigentes sin leer' }) unread: number;
}

export class OpenCountDto {
  @ApiProperty({ description: 'Casos no cerrados' }) open: number;
}

export class OpenAmountDto {
  @ApiProperty({ example: 'COP' }) currency: string;
  @ApiProperty({
    example: '290000.00',
    description: 'Decimal exacto como texto',
  })
  total: string;
  @ApiProperty() count: number;
  @ApiProperty({ description: 'Registros sin valor conocido (no suman)' })
  withoutAmount: number;
}

export class MonthObligationAmountDto {
  @ApiProperty({ example: 'COP' }) currency: string;
  @ApiProperty({
    description: 'Valor esperado de períodos no anulados que vencen en el mes',
  })
  expected: string;
  @ApiProperty({
    description: 'Valor de períodos que el usuario declaró pagados o atendidos',
  })
  confirmed: string;
}

export class MonthRentAmountDto {
  @ApiProperty({ example: 'COP' }) currency: string;
  @ApiProperty({ description: 'Valor esperado de cobros no anulados del mes' })
  expected: string;
  @ApiProperty({
    description: 'Valor de cobros cuya recepción confirmó el usuario',
  })
  received: string;
}

export class MonthRangeDto {
  @ApiProperty({ example: '2026-10-01' }) start: string;
  @ApiProperty({ example: '2026-11-01', description: 'Exclusivo' }) end: string;
}

export class MoneySummaryDto {
  @ApiProperty({
    description:
      'Valores esperados y confirmados por el usuario; no son saldos bancarios ni pagos verificados',
  })
  note: string;
  @ApiProperty({
    type: [OpenAmountDto],
    description: 'Períodos abiertos, por moneda',
  })
  obligationsOpen: OpenAmountDto[];
  @ApiProperty({
    type: [OpenAmountDto],
    description: 'Cobros abiertos, por moneda',
  })
  rentOpen: OpenAmountDto[];
  @ApiProperty({
    type: MonthRangeDto,
    description: 'Mes de referencia (por fecha de vencimiento)',
  })
  month: MonthRangeDto;
  @ApiProperty({ type: [MonthObligationAmountDto] })
  obligationsThisMonth: MonthObligationAmountDto[];
  @ApiProperty({ type: [MonthRentAmountDto] })
  rentThisMonth: MonthRentAmountDto[];
}

export class DashboardSummaryDto {
  @ApiProperty({ example: '2026-10-29' }) referenceDate: string;
  @ApiProperty({ example: 'America/Bogota' }) timeZone: string;
  @ApiProperty({ type: PropertyCountsDto }) properties: PropertyCountsDto;
  @ApiProperty({ type: ObligationCountsDto }) obligations: ObligationCountsDto;
  @ApiProperty({ type: RentChargeCountsDto }) rentCharges: RentChargeCountsDto;
  @ApiProperty({ type: ContractCountsDto }) contracts: ContractCountsDto;
  @ApiProperty({ type: PendingCountDto }) hitl: PendingCountDto;
  @ApiProperty({ type: AlertCountsDto }) alerts: AlertCountsDto;
  @ApiProperty({ type: OpenCountDto }) cases: OpenCountDto;
  @ApiProperty({ type: MoneySummaryDto }) money: MoneySummaryDto;
}
