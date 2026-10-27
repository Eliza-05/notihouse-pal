import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';
import {
  OptionalNotNull,
  OptionalNullable,
  Trim,
} from '../../common/dto-helpers.js';
import { PageMetaDto, PaginationQueryDto } from '../../common/pagination.js';
import { recordStatus } from '../../database/schema/index.js';

export const PROPERTY_STATUSES = recordStatus.enumValues;
export type PropertyStatus = (typeof PROPERTY_STATUSES)[number];

/** El propietario se toma del JWT: no hay `ownerId` en ningún DTO. */
export class CreatePropertyDto {
  @ApiProperty({ example: 'Apartamento centro', maxLength: 120 })
  @Trim()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @Trim()
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string | null;
}

/**
 * Campos editables. No hay borrado físico: un inmueble se desactiva con
 * `status: inactive` o `archived`.
 */
export class UpdatePropertyDto {
  @ApiPropertyOptional({ maxLength: 120 })
  @Trim()
  @OptionalNotNull()
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 300 })
  @Trim()
  @OptionalNullable()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, maxLength: 1000 })
  @Trim()
  @OptionalNullable()
  @IsString()
  @MaxLength(1000)
  description?: string | null;

  @ApiPropertyOptional({ enum: PROPERTY_STATUSES })
  @OptionalNotNull()
  @IsIn(PROPERTY_STATUSES)
  status?: PropertyStatus;
}

export class ListPropertiesQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: PROPERTY_STATUSES })
  @IsOptional()
  @IsIn(PROPERTY_STATUSES)
  status?: PropertyStatus;
}

export class PropertyResponseDto {
  @ApiProperty({ format: 'uuid' })
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ type: String, nullable: true })
  address: string | null;

  @ApiProperty({ type: String, nullable: true })
  description: string | null;

  @ApiProperty({ enum: PROPERTY_STATUSES })
  status: PropertyStatus;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt: Date;
}

export class PropertyPageDto extends PageMetaDto {
  @ApiProperty({ type: [PropertyResponseDto] })
  items: PropertyResponseDto[];
}
