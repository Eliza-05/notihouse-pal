import { Inject, Injectable, UnauthorizedException } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import { and, eq } from 'drizzle-orm';
import { DRIZZLE, type Database } from '../database/database.constants.js';
import { authAccounts, profiles } from '../database/schema/index.js';
import {
  ACCESS_TOKEN_TTL_SECONDS,
  INVALID_CREDENTIALS_MESSAGE,
} from './auth.constants.js';
import type { AuthenticatedUser } from './authenticated-user.js';
import type { LoginResponseDto } from './dto/auth-responses.dto.js';
import { verifyAgainstDummyHash, verifyPassword } from './password.js';
import { sessionVersion } from './session-version.js';

@Injectable()
export class AuthService {
  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    private readonly jwt: JwtService,
  ) {}

  /** `email` llega normalizado por `LoginDto`. */
  async login(email: string, password: string): Promise<LoginResponseDto> {
    const [account] = await this.db
      .select({
        profileId: authAccounts.profileId,
        email: authAccounts.email,
        passwordHash: authAccounts.passwordHash,
        isActive: authAccounts.isActive,
        passwordChangedAt: authAccounts.passwordChangedAt,
        displayName: profiles.displayName,
      })
      .from(authAccounts)
      .innerJoin(profiles, eq(profiles.id, authAccounts.profileId))
      .where(eq(authAccounts.email, email))
      .limit(1);

    // La contraseña se verifica siempre (también para cuentas inexistentes o
    // inactivas) para que el tiempo de respuesta no revele qué ocurrió.
    const passwordMatches = account
      ? await verifyPassword(account.passwordHash, password)
      : await verifyAgainstDummyHash(password);

    if (!account || !passwordMatches || !account.isActive) {
      throw new UnauthorizedException(INVALID_CREDENTIALS_MESSAGE);
    }

    const accessToken = await this.jwt.signAsync({
      sub: account.profileId,
      sv: sessionVersion(account.profileId, account.passwordChangedAt),
    });
    return {
      accessToken,
      tokenType: 'Bearer',
      expiresIn: ACCESS_TOKEN_TTL_SECONDS,
      user: {
        id: account.profileId,
        email: account.email,
        displayName: account.displayName,
      },
    };
  }

  /**
   * Devuelve el usuario si su cuenta sigue activa y el token corresponde a la
   * contraseña vigente; en otro caso, `null`. La versión de sesión (`sv`)
   * distingue cambios dentro del mismo segundo; `iat` se sigue comprobando
   * como defensa adicional.
   */
  async findActiveUser(
    profileId: string,
    tokenIssuedAtSeconds: number,
    tokenSessionVersion: string,
  ): Promise<AuthenticatedUser | null> {
    const [row] = await this.db
      .select({
        profileId: authAccounts.profileId,
        email: authAccounts.email,
        displayName: profiles.displayName,
        passwordChangedAt: authAccounts.passwordChangedAt,
      })
      .from(authAccounts)
      .innerJoin(profiles, eq(profiles.id, authAccounts.profileId))
      .where(
        and(
          eq(authAccounts.profileId, profileId),
          eq(authAccounts.isActive, true),
        ),
      )
      .limit(1);

    if (!row) return null;
    const changedAtSeconds = Math.floor(row.passwordChangedAt.getTime() / 1000);
    if (tokenIssuedAtSeconds < changedAtSeconds) return null;
    if (
      tokenSessionVersion !==
      sessionVersion(row.profileId, row.passwordChangedAt)
    ) {
      return null;
    }

    return {
      profileId: row.profileId,
      email: row.email,
      displayName: row.displayName,
    };
  }
}
