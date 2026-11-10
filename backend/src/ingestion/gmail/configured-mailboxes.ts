import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { and, eq } from 'drizzle-orm';
import type { AuthenticatedUser } from '../../auth/authenticated-user.js';
import {
  type EnvironmentVariables,
  parseMailboxLinks,
} from '../../config/env.validation.js';
import { DRIZZLE, type Database } from '../../database/database.constants.js';
import { authAccounts, profiles } from '../../database/schema/index.js';
import {
  type GmailMailboxResolver,
  normalizeMailbox,
} from './gmail.contract.js';

/**
 * Vínculos buzón → perfil definidos por el operador en `GMAIL_MAILBOX_LINKS`
 * (solo en el servidor). Ninguna solicitud puede crearlos ni modificarlos.
 * Sin esa variable ningún buzón resuelve y la ruta responde 403. Un vínculo a
 * una cuenta inexistente o desactivada tampoco resuelve.
 */
@Injectable()
export class ConfiguredMailboxes implements GmailMailboxResolver {
  private readonly links: Map<string, string>;

  constructor(
    @Inject(DRIZZLE) private readonly db: Database,
    @Inject(ConfigService)
    config: Pick<ConfigService<EnvironmentVariables, true>, 'get'>,
  ) {
    this.links = parseMailboxLinks(
      config.get('GMAIL_MAILBOX_LINKS', { infer: true }),
    );
  }

  async resolveOwner(mailbox: string): Promise<AuthenticatedUser | null> {
    const profileId = this.links.get(normalizeMailbox(mailbox));
    if (!profileId) return null;
    const [owner] = await this.db
      .select({
        profileId: authAccounts.profileId,
        email: authAccounts.email,
        displayName: profiles.displayName,
      })
      .from(authAccounts)
      .innerJoin(profiles, eq(profiles.id, authAccounts.profileId))
      .where(
        and(
          eq(authAccounts.profileId, profileId),
          eq(authAccounts.isActive, true),
        ),
      );
    return owner ?? null;
  }
}
