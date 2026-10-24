import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { id, timestamps, tstz } from './columns.js';
import { linkValidationStatus } from './enums.js';

/** Catálogo global de proveedores de servicios (empresas de energía, agua, etc.). */
export const providers = pgTable(
  'providers',
  {
    id: id(),
    name: text('name').notNull(),
    slug: text('slug').notNull().unique(),
    ...timestamps(),
  },
  (t) => [
    check('providers_slug_format', sql`${t.slug} ~ '^[a-z0-9]+(-[a-z0-9]+)*$'`),
  ],
);

/**
 * Enlaces oficiales de pago registrados y validados manualmente.
 * Nunca se generan ni infieren mediante IA; solo se presentan los `validated`.
 */
export const providerPaymentLinks = pgTable(
  'provider_payment_links',
  {
    id: id(),
    providerId: uuid('provider_id')
      .notNull()
      .references(() => providers.id, { onDelete: 'restrict' }),
    url: text('url').notNull(),
    validationStatus: linkValidationStatus('validation_status')
      .notNull()
      .default('pending'),
    validatedAt: tstz('validated_at'),
    ...timestamps(),
  },
  (t) => [
    unique('provider_payment_links_provider_url_unique').on(
      t.providerId,
      t.url,
    ),
    index('provider_payment_links_provider_idx').on(t.providerId),
    check('provider_payment_links_https', sql`${t.url} ~ '^https://'`),
    check(
      'provider_payment_links_validated_at',
      sql`(${t.validationStatus} = 'validated') = (${t.validatedAt} IS NOT NULL)`,
    ),
  ],
);
