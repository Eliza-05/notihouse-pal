import { ApiProperty } from '@nestjs/swagger';
import { ACCESS_TOKEN_TTL_SECONDS } from '../auth.constants.js';

export class AuthUserDto {
  @ApiProperty({ format: 'uuid', description: 'Identificador del perfil' })
  id: string;

  @ApiProperty({ example: 'laura.martinez@notihouse.com' })
  email: string;

  @ApiProperty({ type: String, nullable: true, example: 'Laura Martínez' })
  displayName: string | null;
}

export class LoginResponseDto {
  @ApiProperty({ description: 'JWT firmado (HS256)' })
  accessToken: string;

  @ApiProperty({ type: String, example: 'Bearer' })
  tokenType: 'Bearer';

  @ApiProperty({ example: ACCESS_TOKEN_TTL_SECONDS, description: 'Segundos' })
  expiresIn: number;

  @ApiProperty({ type: AuthUserDto })
  user: AuthUserDto;
}
