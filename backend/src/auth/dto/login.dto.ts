import { ApiProperty } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsEmail, IsNotEmpty, IsString, MaxLength } from 'class-validator';

export function normalizeEmail(value: unknown): unknown {
  return typeof value === 'string' ? value.trim().toLowerCase() : value;
}

export class LoginDto {
  @ApiProperty({ example: 'laura.martinez@notihouse.com', maxLength: 254 })
  @Transform(({ value }) => normalizeEmail(value))
  @IsEmail({}, { message: 'email debe ser un correo válido' })
  @MaxLength(254)
  email: string;

  @ApiProperty({ format: 'password', maxLength: 256 })
  @IsString({ message: 'password debe ser texto' })
  @IsNotEmpty({ message: 'password es obligatoria' })
  // Acota el costo de verificación ante entradas enormes.
  @MaxLength(256)
  password: string;
}
