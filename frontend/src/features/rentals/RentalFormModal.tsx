import { zodResolver } from '@hookform/resolvers/zod'
import { Controller, useForm } from 'react-hook-form'
import { z } from 'zod'
import { Modal } from '../../components/Modal'
import { ApiError } from '../../lib/api/errors'
import { MoneyInput } from '../../components/MoneyInput'
import { moneyToDisplay, toWireMoney } from '../../lib/format/cop'
import { calendarDateField, positiveMoneyField } from '../../lib/format/validation'
import { useProperties } from '../properties/hooks'
import { useCreateRental, useUpdateRental } from './hooks'
import type { Rental } from '../../lib/api/types'

const schema = z
  .object({
    propertyId: z.string().min(1, 'Elige un inmueble'),
    tenantAlias: z.string().trim().max(120).optional().or(z.literal('')),
    expectedAmount: positiveMoneyField(),
    dueDay: z.string().min(1, 'Ingresa el día de cobro'),
    startsOn: calendarDateField({ required: true }),
    endsOn: calendarDateField(),
    autoGenerate: z.boolean(),
  })
  .refine((v) => !v.endsOn || v.endsOn >= v.startsOn, { message: 'La fecha de fin no puede ser anterior a la de inicio', path: ['endsOn'] })
type FormValues = z.infer<typeof schema>

export function RentalFormModal({ rental, onClose }: { rental?: Rental; onClose: () => void }) {
  const isEdit = !!rental
  const create = useCreateRental()
  const update = useUpdateRental()
  const { data: properties } = useProperties({ pageSize: 100, status: 'active' })
  const {
    register,
    control,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: {
      propertyId: rental?.propertyId ?? '',
      tenantAlias: rental?.tenantAlias ?? '',
      expectedAmount: moneyToDisplay(rental?.expectedAmount),
      dueDay: rental ? String(rental.dueDay) : '',
      startsOn: rental?.startsOn ?? '',
      endsOn: rental?.endsOn ?? '',
      autoGenerate: rental?.autoGenerate ?? false,
    },
  })

  async function onSubmit(values: FormValues) {
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: rental.id,
          input: {
            tenantAlias: values.tenantAlias || null,
            expectedAmount: toWireMoney(values.expectedAmount)!,
            dueDay: Number(values.dueDay),
            startsOn: values.startsOn,
            endsOn: values.endsOn || null,
            autoGenerate: values.autoGenerate,
          },
        })
      } else {
        await create.mutateAsync({
          propertyId: values.propertyId,
          tenantAlias: values.tenantAlias || undefined,
          expectedAmount: toWireMoney(values.expectedAmount)!,
          dueDay: Number(values.dueDay),
          startsOn: values.startsOn,
          endsOn: values.endsOn || undefined,
          autoGenerate: values.autoGenerate,
        })
      }
      onClose()
    } catch (err) {
      if (err instanceof ApiError) setError('propertyId', { message: err.messages.join(' ') })
    }
  }

  return (
    <Modal title={isEdit ? 'Editar arriendo' : 'Nuevo arriendo'} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="form-grid">
          <div className="field">
            <label htmlFor="propertyId">Inmueble</label>
            <select id="propertyId" {...register('propertyId')} disabled={isEdit}>
              <option value="">Elige un inmueble</option>
              {properties?.items.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            {errors.propertyId && <span className="field-error">{errors.propertyId.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="tenantAlias">Alias del arrendatario (no datos personales)</label>
            <input id="tenantAlias" {...register('tenantAlias')} />
          </div>
          <div className="field">
            <label htmlFor="expectedAmount">Canon mensual</label>
            <Controller name="expectedAmount" control={control} render={({ field }) => (
              <MoneyInput id="expectedAmount" placeholder="950.000" name={field.name} value={field.value} onChange={field.onChange} onBlur={field.onBlur} aria-invalid={!!errors.expectedAmount} />
            )} />
            {errors.expectedAmount && <span className="field-error">{errors.expectedAmount.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="dueDay">Día de cobro (1-31)</label>
            <input id="dueDay" type="number" min={1} max={31} {...register('dueDay')} />
            {errors.dueDay && <span className="field-error">{errors.dueDay.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="startsOn">Inicio</label>
            <input id="startsOn" type="date" {...register('startsOn')} />
            {errors.startsOn && <span className="field-error">{errors.startsOn.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="endsOn">Fin (opcional)</label>
            <input id="endsOn" type="date" {...register('endsOn')} />
            {errors.endsOn && <span className="field-error">{errors.endsOn.message}</span>}
          </div>
        </div>
        <div className="field-checkbox">
          <input id="autoGenerate" type="checkbox" {...register('autoGenerate')} />
          <label htmlFor="autoGenerate" style={{ fontWeight: 400 }}>
            Generar cobros esperados automáticamente. No se cobra ni se envía ningún mensaje al arrendatario.
          </label>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end', marginTop: '0.5rem' }}>
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
