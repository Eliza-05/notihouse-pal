import * as schema from '../schema/index.js';
import type { SeedTransaction } from './demo-seed.js';

/**
 * Identidades y datos ficticios de los cuatro usuarios de demostración.
 * Los correos @notihouse.com son solo identificadores de inicio de sesión:
 * nunca se envían mensajes a ellos ni se usan para recuperar cuentas.
 * Todos los registros quedan en estados iniciales legítimos: ningún pago,
 * cobro, alerta, documento ni propuesta de IA se presenta como ya ocurrido.
 */
export interface DemoUser {
  email: string;
  displayName: string;
  /** Correo usado por versiones anteriores del seed (ver updateLegacyDemoIdentities). */
  legacyEmail: string;
  seedData: (tx: SeedTransaction, ownerId: string) => Promise<void>;
}

const FICTITIOUS_ADDRESS = 'Dirección ficticia de demostración';

export const DEMO_USERS: readonly DemoUser[] = [
  {
    email: 'laura.martinez@notihouse.com',
    displayName: 'Laura Martínez',
    legacyEmail: 'hogar@notihouse.test',
    async seedData(tx, ownerId) {
      const [property] = await tx
        .insert(schema.properties)
        .values({
          ownerId,
          name: 'Apartamento Demo Hogar',
          address: FICTITIOUS_ADDRESS,
          description: 'Vivienda residencial ficticia',
        })
        .returning({ id: schema.properties.id });
      const propertyId = property!.id;

      const [energy, water, internet] = await tx
        .insert(schema.obligations)
        .values([
          {
            ownerId,
            propertyId,
            providerName: 'Empresa de energía (ficticia)',
            concept: 'Energía eléctrica',
            category: 'electricity',
            expectedAmount: '145000.00',
            frequency: 'monthly',
            dueDay: 18,
            startsOn: '2026-01-01',
          },
          {
            ownerId,
            propertyId,
            providerName: 'Empresa de acueducto (ficticia)',
            concept: 'Acueducto y alcantarillado',
            category: 'water',
            expectedAmount: '98000.00',
            frequency: 'bimonthly',
            dueDay: 22,
            startsOn: '2026-01-01',
          },
          {
            ownerId,
            propertyId,
            providerName: 'Proveedor de internet (ficticio)',
            concept: 'Internet hogar',
            category: 'internet',
            expectedAmount: '89900.00',
            frequency: 'monthly',
            dueDay: 5,
            startsOn: '2026-01-01',
          },
        ])
        .returning({ id: schema.obligations.id });

      await tx.insert(schema.obligationOccurrences).values([
        {
          obligationId: energy!.id,
          ownerId,
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          amount: '145000.00',
          dueDate: '2026-11-18',
          status: 'pending',
        },
        {
          obligationId: energy!.id,
          ownerId,
          periodStart: '2026-12-01',
          periodEnd: '2026-12-31',
          amount: '145000.00',
          dueDate: '2026-12-18',
          status: 'pending',
        },
        {
          obligationId: water!.id,
          ownerId,
          periodStart: '2026-11-01',
          periodEnd: '2026-12-31',
          amount: '98000.00',
          dueDate: '2026-11-22',
          status: 'pending',
        },
        {
          obligationId: internet!.id,
          ownerId,
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          amount: '89900.00',
          dueDate: '2026-11-05',
          status: 'pending',
        },
      ]);
    },
  },
  {
    email: 'andres.gomez@notihouse.com',
    displayName: 'Andrés Gómez',
    legacyEmail: 'arriendos@notihouse.test',
    async seedData(tx, ownerId) {
      const [property] = await tx
        .insert(schema.properties)
        .values({
          ownerId,
          name: 'Apartaestudio Demo Arriendos',
          address: FICTITIOUS_ADDRESS,
          description: 'Inmueble ficticio en arriendo',
        })
        .returning({ id: schema.properties.id });
      const propertyId = property!.id;

      const [rental] = await tx
        .insert(schema.rentals)
        .values({
          ownerId,
          propertyId,
          tenantAlias: 'Arrendatario ficticio A',
          expectedAmount: '1200000.00',
          dueDay: 5,
          startsOn: '2026-02-01',
          endsOn: '2027-01-31',
          status: 'active',
        })
        .returning({ id: schema.rentals.id });

      await tx.insert(schema.rentCharges).values([
        {
          rentalId: rental!.id,
          ownerId,
          periodStart: '2026-11-01',
          periodEnd: '2026-11-30',
          expectedAmount: '1200000.00',
          dueDate: '2026-11-05',
          status: 'expected',
        },
        {
          rentalId: rental!.id,
          ownerId,
          periodStart: '2026-12-01',
          periodEnd: '2026-12-31',
          expectedAmount: '1200000.00',
          dueDate: '2026-12-05',
          status: 'expected',
        },
      ]);

      const [administration] = await tx
        .insert(schema.obligations)
        .values({
          ownerId,
          propertyId,
          providerName: 'Administración del edificio (ficticia)',
          concept: 'Cuota de administración',
          category: 'administration',
          expectedAmount: '180000.00',
          frequency: 'monthly',
          dueDay: 10,
          startsOn: '2026-02-01',
        })
        .returning({ id: schema.obligations.id });

      await tx.insert(schema.obligationOccurrences).values({
        obligationId: administration!.id,
        ownerId,
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        amount: '180000.00',
        dueDate: '2026-11-10',
        status: 'pending',
      });
    },
  },
  {
    email: 'camila.torres@notihouse.com',
    displayName: 'Camila Torres',
    legacyEmail: 'contratos@notihouse.test',
    async seedData(tx, ownerId) {
      const [property] = await tx
        .insert(schema.properties)
        .values({
          ownerId,
          name: 'Local comercial Demo Contratos',
          address: FICTITIOUS_ADDRESS,
          description: 'Inmueble ficticio con contrato vigente',
        })
        .returning({ id: schema.properties.id });
      const propertyId = property!.id;

      const [rental] = await tx
        .insert(schema.rentals)
        .values({
          ownerId,
          propertyId,
          tenantAlias: 'Arrendatario ficticio B',
          expectedAmount: '2500000.00',
          dueDay: 16,
          startsOn: '2025-12-16',
          endsOn: '2026-12-15',
          status: 'active',
        })
        .returning({ id: schema.rentals.id });

      // Vence el 2026-12-15 con 30 días de preaviso: sirve para probar alertas de vencimiento.
      await tx.insert(schema.contracts).values({
        ownerId,
        propertyId,
        rentalId: rental!.id,
        startsOn: '2025-12-16',
        endsOn: '2026-12-15',
        noticePeriodDays: 30,
        status: 'active',
      });
    },
  },
  {
    email: 'daniel.rojas@notihouse.com',
    displayName: 'Daniel Rojas',
    legacyEmail: 'integracion@notihouse.test',
    async seedData(tx, ownerId) {
      const [property] = await tx
        .insert(schema.properties)
        .values({
          ownerId,
          name: 'Casa Demo Integración',
          address: FICTITIOUS_ADDRESS,
          description: 'Inmueble ficticio para pruebas de IA, voz y documentos',
        })
        .returning({ id: schema.properties.id });

      const [gas] = await tx
        .insert(schema.obligations)
        .values({
          ownerId,
          propertyId: property!.id,
          providerName: 'Empresa de gas (ficticia)',
          concept: 'Gas natural',
          category: 'gas',
          expectedAmount: '62000.00',
          frequency: 'monthly',
          dueDay: 12,
          startsOn: '2026-01-01',
        })
        .returning({ id: schema.obligations.id });

      await tx.insert(schema.obligationOccurrences).values({
        obligationId: gas!.id,
        ownerId,
        periodStart: '2026-11-01',
        periodEnd: '2026-11-30',
        amount: '62000.00',
        dueDate: '2026-11-12',
        status: 'pending',
      });
    },
  },
];

export const DEMO_EMAILS = DEMO_USERS.map((u) => u.email);
export const LEGACY_DEMO_EMAILS = DEMO_USERS.map((u) => u.legacyEmail);
