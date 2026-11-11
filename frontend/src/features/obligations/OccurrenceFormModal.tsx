import { zodResolver } from '@hookform/resolvers/zod'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { Modal } from '../../components/Modal'
import { ApiError } from '../../lib/api/errors'
import { MoneyInput } from '../../components/MoneyInput'
import { moneyToDisplay, toWireMoney } from '../../lib/format/cop'
import { calendarDateField, moneyField } from '../../lib/format/validation'
import { useCreateOccurrence, useUpdateOccurrence } from './hooks'
import type { ObligationOccurrence } from '../../lib/api/types'

const schema = z
  .object({
    periodStart: calendarDateField({ required: true }),
    periodEnd: calendarDateField({ required: true }),
    dueDate: calendarDateField({ required: true }),
    amount: moneyField(),
  })
  .refine((v) => v.periodEnd >= v.periodStart, { message: 'El fin del período no puede ser anterior al inicio', path: ['periodEnd'] })
type FormValues = z.infer<typeof schema>

export function OccurrenceFormModal({
  obligationId,
  occurrence,
  onClose,
}: {
  obligationId: string
  occurrence?: ObligationOccurrence
  onClose: () => void
}) {
  const isEdit = !!occurrence
  const create = useCreateOccurrence(obligationId)
  const update = useUpdateOccurrence(obligationId)
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      periodStart: occurrence?.periodStart ?? '',
      periodEnd: occurrence?.periodEnd ?? '',
      dueDate: occurrence?.dueDate ?? '',
      amount: moneyToDisplay(occurrence?.amount),
    },
  })

  async function onSubmit(values: FormValues) {
    try {
      if (isEdit) {
        await update.mutateAsync({
          occurrenceId: occurrence.id,
          input: {
            periodStart: values.periodStart,
            periodEnd: values.periodEnd,
            dueDate: values.dueDate,
            amount: toWireMoney(values.amount) ?? null,
          },
        })
      } else {
        await create.mutateAsync({
          periodStart: values.periodStart,
          periodEnd: values.periodEnd,
          dueDate: values.dueDate,
          amount: toWireMoney(values.amount),
        })
      }
      onClose()
    } catch (err) {
      if (err instanceof ApiError) setError('dueDate', { message: err.messages.join(' ') })
    }
  }

  return (
    <Modal title={isEdit ? 'Editar período' : 'Nuevo período'} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="periodStart">Inicio del período</label>
            <input id="periodStart" type="date" {...register('periodStart')} />
            {errors.periodStart && <span className="field-error">{errors.periodStart.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="periodEnd">Fin del período</label>
            <input id="periodEnd" type="date" {...register('periodEnd')} />
            {errors.periodEnd && <span className="field-error">{errors.periodEnd.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="dueDate">Vence</label>
            <input id="dueDate" type="date" {...register('dueDate')} />
            {errors.dueDate && <span className="field-error">{errors.dueDate.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="amount">Monto (opcional, copia el esperado si se omite)</label>
            <Controller name="amount" control={control} render={({ field }) => (
              <MoneyInput id="amount" placeholder="145.000" name={field.name} value={field.value} onChange={field.onChange} onBlur={field.onBlur} aria-invalid={!!errors.amount} />
            )} />
            {errors.amount && <span className="field-error">{errors.amount.message}</span>}
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
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
