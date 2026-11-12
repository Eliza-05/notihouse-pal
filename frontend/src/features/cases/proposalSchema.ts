import { z } from 'zod'

/**
 * `proposedData` es JSON libre (§6.10, §19.4): se valida con Zod antes de
 * mostrar nada. Si no encaja con ninguna forma conocida, se muestra el JSON
 * y se marca "requiere revisión manual" (nunca se inventa una interpretación).
 */

const obligationFields = z.object({
  providerName: z.string(),
  concept: z.string(),
  category: z.string(),
  expectedAmount: z.string().nullish(),
  currency: z.string().optional(),
  propertyId: z.string().nullish(),
})

const occurrenceFields = z.object({
  periodStart: z.string(),
  periodEnd: z.string(),
  dueDate: z.string(),
  amount: z.string().nullish(),
  currency: z.string().optional(),
})

const createOccurrence = z.object({
  action: z.literal('create_obligation_occurrence'),
  data: occurrenceFields.extend({ obligationId: z.string() }),
})

const createWithOccurrence = z.object({
  action: z.literal('create_obligation_with_occurrence'),
  data: z.object({ obligation: obligationFields, occurrence: occurrenceFields }),
})

const createRecurringObligation = z.object({
  action: z.literal('create_recurring_obligation'),
  data: z.object({
    obligation: obligationFields.extend({
      frequency: z.string().optional(),
      dueDay: z.number(),
      reminderDaysBefore: z.number().optional(),
      startsOn: z.string().nullish(),
    }),
  }),
})

const scheduleFields = z.object({
  dueDay: z.number().nullish(),
  reminderDaysBefore: z.number().optional(),
  expectedAmount: z.string().nullish(),
})

const updateObligationSchedule = z.object({
  action: z.literal('update_obligation_schedule'),
  data: z.object({ obligationId: z.string(), expected: scheduleFields, changes: scheduleFields }),
})

const updateOccurrenceDetails = z.object({
  action: z.literal('update_occurrence_details'),
  data: z.object({
    obligationId: z.string(),
    occurrenceId: z.string(),
    amount: z.string().optional(),
    dueDate: z.string().optional(),
  }),
})

const createRecurringRental = z.object({
  action: z.literal('create_recurring_rental'),
  data: z.object({
    rental: z.object({
      propertyId: z.string(),
      expectedAmount: z.string(),
      dueDay: z.number(),
      startsOn: z.string(),
      endsOn: z.string().nullish(),
      tenantAlias: z.string().nullish(),
      currency: z.string().optional(),
    }),
  }),
})

const archiveObligation = z.object({
  action: z.literal('archive_obligation'),
  data: z.object({
    obligationId: z.string(),
    expected: z.object({ providerName: z.string(), concept: z.string() }),
  }),
})

const guided = z.object({
  guided: z.object({
    kind: z.string(),
    obligationId: z.string().optional(),
    occurrenceId: z.string().optional(),
    rentalId: z.string().optional(),
    chargeId: z.string().optional(),
  }),
})

const knownProposal = z.discriminatedUnion('action', [
  createOccurrence,
  createWithOccurrence,
  createRecurringObligation,
  updateObligationSchedule,
  updateOccurrenceDetails,
  createRecurringRental,
  archiveObligation,
])

export type KnownProposal = z.infer<typeof knownProposal>
export type GuidedProposal = z.infer<typeof guided>

export type ParsedProposal =
  | { kind: 'known'; value: KnownProposal }
  | { kind: 'guided'; value: GuidedProposal }
  | { kind: 'transcript'; value: { transcript: string; language?: string } }
  | { kind: 'unknown'; raw: unknown }

export function parseProposal(raw: unknown): ParsedProposal {
  const known = knownProposal.safeParse(raw)
  if (known.success) return { kind: 'known', value: known.data }

  const guidedResult = guided.safeParse(raw)
  if (guidedResult.success) return { kind: 'guided', value: guidedResult.data }

  const transcript = z.object({ transcript: z.string(), language: z.string().optional() }).safeParse(raw)
  if (transcript.success) return { kind: 'transcript', value: transcript.data }

  return { kind: 'unknown', raw }
}
