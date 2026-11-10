import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { Modal } from '../../components/Modal'
import { ApiError } from '../../lib/api/errors'
import { moneyField } from '../../lib/format/validation'
import { OBLIGATION_CATEGORY_LABELS, OBLIGATION_FREQUENCY_LABELS } from '../../lib/format/labels'
import { useProperties } from '../properties/hooks'
import { useCreateObligation, useUpdateObligation } from './hooks'
import type { Obligation, ObligationCategory, ObligationFrequency } from '../../lib/api/types'

const CATEGORIES = Object.keys(OBLIGATION_CATEGORY_LABELS) as ObligationCategory[]
const FREQUENCIES = Object.keys(OBLIGATION_FREQUENCY_LABELS) as ObligationFrequency[]

const schema = z.object({
  providerName: z.string().trim().min(1, 'Ingresa el proveedor').max(120),
  concept: z.string().trim().min(1, 'Ingresa el concepto').max(160),
  category: z.enum(CATEGORIES as [ObligationCategory, ...ObligationCategory[]]),
  propertyId: z.string().optional(),
  expectedAmount: moneyField(),
  frequency: z.enum(FREQUENCIES as [ObligationFrequency, ...ObligationFrequency[]]),
  dueDay: z.string().optional(),
  reminderDaysBefore: z.string().optional(),
  startsOn: z.string().optional(),
  autoGenerate: z.boolean(),
})
type FormValues = z.infer<typeof schema>

export function ObligationFormModal({ obligation, onClose }: { obligation?: Obligation; onClose: () => void }) {
  const isEdit = !!obligation
  const create = useCreateObligation()
  const update = useUpdateObligation()
  const { data: properties } = useProperties({ pageSize: 100, status: 'active' })

  const {
    register,
    handleSubmit,
    watch,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      providerName: obligation?.providerName ?? '',
      concept: obligation?.concept ?? '',
      category: obligation?.category ?? 'other',
      propertyId: obligation?.propertyId ?? '',
      expectedAmount: obligation?.expectedAmount ?? '',
      frequency: obligation?.frequency ?? 'monthly',
      dueDay: obligation?.dueDay != null ? String(obligation.dueDay) : '',
      reminderDaysBefore: obligation ? String(obligation.reminderDaysBefore) : '3',
      startsOn: obligation?.startsOn ?? '',
      autoGenerate: obligation?.autoGenerate ?? false,
    },
  })
  const autoGenerate = watch('autoGenerate')
  const dueDay = watch('dueDay')
  const reminderDaysBefore = watch('reminderDaysBefore')

  async function onSubmit(values: FormValues) {
    const dueDayNum = values.dueDay ? Number(values.dueDay) : undefined
    const reminderNum = values.reminderDaysBefore ? Number(values.reminderDaysBefore) : undefined
    if (values.autoGenerate && !dueDayNum) {
      setError('dueDay', { message: 'Indica el día de vencimiento para generar automáticamente' })
      return
    }
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: obligation.id,
          input: {
            providerName: values.providerName,
            concept: values.concept,
            category: values.category,
            propertyId: values.propertyId || null,
            expectedAmount: values.expectedAmount || null,
            frequency: values.frequency,
            dueDay: dueDayNum ?? null,
            reminderDaysBefore: reminderNum,
            startsOn: values.startsOn || null,
            autoGenerate: values.autoGenerate,
          },
        })
      } else {
        await create.mutateAsync({
          providerName: values.providerName,
          concept: values.concept,
          category: values.category,
          propertyId: values.propertyId || undefined,
          expectedAmount: values.expectedAmount || undefined,
          frequency: values.frequency,
          dueDay: dueDayNum,
          reminderDaysBefore: reminderNum,
          startsOn: values.startsOn || undefined,
          autoGenerate: values.autoGenerate,
        })
      }
      onClose()
    } catch (err) {
      if (err instanceof ApiError) setError('providerName', { message: err.messages.join(' ') })
    }
  }

  const reminderExplainer =
    dueDay && reminderDaysBefore
      ? `Vence el ${dueDay} · aviso ${reminderDaysBefore} día(s) antes → día ${
          ((Number(dueDay) - Number(reminderDaysBefore)) % 31 + 31) % 31 || Number(dueDay)
        }`
      : null

  return (
    <Modal title={isEdit ? 'Editar obligación' : 'Nueva obligación'} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="providerName">Proveedor</label>
            <input id="providerName" {...register('providerName')} />
            {errors.providerName && <span className="field-error">{errors.providerName.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="concept">Concepto</label>
            <input id="concept" {...register('concept')} />
            {errors.concept && <span className="field-error">{errors.concept.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="category">Categoría</label>
            <select id="category" {...register('category')}>
              {CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {OBLIGATION_CATEGORY_LABELS[c]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="propertyId">Inmueble (opcional)</label>
            <select id="propertyId" {...register('propertyId')}>
              <option value="">Sin inmueble asignado</option>
              {properties?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="expectedAmount">Monto esperado (opcional)</label>
            <input id="expectedAmount" inputMode="decimal" placeholder="145000.00" {...register('expectedAmount')} />
            {errors.expectedAmount && <span className="field-error">{errors.expectedAmount.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="frequency">Frecuencia</label>
            <select id="frequency" {...register('frequency')} disabled={isEdit}>
              {FREQUENCIES.map((f) => (
                <option key={f} value={f}>
                  {OBLIGATION_FREQUENCY_LABELS[f]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="dueDay">Día de vencimiento (1-31)</label>
            <input id="dueDay" type="number" min={1} max={31} {...register('dueDay')} />
            {errors.dueDay && <span className="field-error">{errors.dueDay.message}</span>}
            <span className="field-help">En meses más cortos se usa el último día del mes.</span>
          </div>
          <div className="field">
            <label htmlFor="reminderDaysBefore">Aviso (días antes, 0-60)</label>
            <input id="reminderDaysBefore" type="number" min={0} max={60} {...register('reminderDaysBefore')} />
          </div>
          <div className="field">
            <label htmlFor="startsOn">Vigente desde (opcional)</label>
            <input id="startsOn" type="date" {...register('startsOn')} />
          </div>
        </div>

        {reminderExplainer && <p className="field-help">{reminderExplainer}</p>}
        <p className="field-help">
          El sistema avisa al menos 7 días antes del vencimiento mientras el aviso personalizado no esté desplegado
          en producción.
        </p>

        <div className="field-checkbox" style={{ marginTop: '0.5rem' }}>
          <input id="autoGenerate" type="checkbox" {...register('autoGenerate')} />
          <label htmlFor="autoGenerate" style={{ fontWeight: 400 }}>
            Generar períodos automáticamente. NotiHouse-Pal creará los registros de seguimiento; no paga ni envía
            mensajes.
          </label>
        </div>
        {autoGenerate && !dueDay && (
          <p className="field-error">Para generar automáticamente necesitas indicar el día de vencimiento.</p>
        )}

        <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <button type="submit" className="btn btn-primary" disabled={isSubmitting}>
            {isSubmitting ? 'Guardando…' : 'Guardar'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
