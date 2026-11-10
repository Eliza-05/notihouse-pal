import { char, numeric, timestamp, uuid } from 'drizzle-orm/pg-core';

export const id = () => uuid('id').primaryKey().defaultRandom();

export const tstz = (name: string) =>
  timestamp(name, { withTimezone: true, mode: 'date' });

export const timestamps = () => ({
  createdAt: tstz('created_at').notNull().defaultNow(),
  updatedAt: tstz('updated_at')
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Valor monetario exacto. Drizzle lo expone como string para no perder precisión. */
export const money = (name: string) =>
  numeric(name, { precision: 14, scale: 2 });

export const currency = () =>
  char('currency', { length: 3 }).notNull().default('COP');
