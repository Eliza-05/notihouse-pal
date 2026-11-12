import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { LoadingButton } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toasts'
import { friendlyError } from '../../lib/api/messages'
import { calendarDateField } from '../../lib/format/validation'
import { useProperties } from '../properties/hooks'
import { useRentals } from '../rentals/hooks'
import { useCreateContract, useUpdateContract } from './hooks'
import type { Contract } from '../../lib/api/types'

const schema = z
  .object({
    propertyId: z.string().min(1, 'Elige un inmueble'),
    rentalId: z.string().optional(),
    startsOn: calendarDateField({ required: true }),
    endsOn: calendarDateField({ required: true }),
    noticePeriodDays: z.string().optional(),
  })
  .refine((v) => v.endsOn >= v.startsOn, { message: 'La fecha de fin no puede ser anterior a la de inicio', path: ['endsOn'] })
type FormValues = z.infer<typeof schema>

export function ContractFormModal({ contract, onClose }: { contract?: Contract; onClose: () => void }) {
  const isEdit = !!contract
  const create = useCreateContract()
  const update = useUpdateContract()
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
      propertyId: contract?.propertyId ?? '',
      rentalId: contract?.rentalId ?? '',
      startsOn: contract?.startsOn ?? '',
      endsOn: contract?.endsOn ?? '',
      noticePeriodDays: contract?.noticePeriodDays != null ? String(contract.noticePeriodDays) : '',
    },
  })
  const propertyId = watch('propertyId')
  const { data: rentals } = useRentals({ propertyId: propertyId || undefined, pageSize: 50 })

  const toast = useToast()
  async function onSubmit(values: FormValues) {
    const notice = values.noticePeriodDays ? Number(values.noticePeriodDays) : undefined
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: contract.id,
          input: { startsOn: values.startsOn, endsOn: values.endsOn, noticePeriodDays: notice ?? null },
        })
      } else {
        await create.mutateAsync({
          propertyId: values.propertyId,
          rentalId: values.rentalId || undefined,
          startsOn: values.startsOn,
          endsOn: values.endsOn,
          noticePeriodDays: notice,
        })
      }
      toast.success(isEdit ? 'Cambios guardados.' : 'Contrato registrado.')
      onClose()
    } catch (err) {
      setError('endsOn', { message: friendlyError(err, 'save') })
    }
  }

  return (
    <Modal title={isEdit ? 'Corregir contrato' : 'Registrar contrato'} onClose={onClose}>
      <p className="field-help">
        NotiHouse-Pal no genera, firma ni renueva contratos: esto solo registra metadatos y vigila el vencimiento.
      </p>
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
            <label htmlFor="rentalId">Arriendo asociado (opcional)</label>
            <select id="rentalId" {...register('rentalId')} disabled={isEdit}>
              <option value="">Sin arriendo asociado</option>
              {rentals?.items.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.tenantAlias ?? r.id}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="startsOn">Inicio</label>
            <input id="startsOn" type="date" {...register('startsOn')} />
            {errors.startsOn && <span className="field-error">{errors.startsOn.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="endsOn">Fin (obligatorio)</label>
            <input id="endsOn" type="date" {...register('endsOn')} />
            {errors.endsOn && <span className="field-error">{errors.endsOn.message}</span>}
          </div>
          <div className="field">
            <label htmlFor="noticePeriodDays">Preaviso en días (opcional, 0-365)</label>
            <input id="noticePeriodDays" type="number" min={0} max={365} {...register('noticePeriodDays')} />
          </div>
        </div>
        <div className="row" style={{ justifyContent: 'flex-end' }}>
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancelar
          </button>
          <LoadingButton type="submit" loading={isSubmitting} loadingText="Guardando…">
            Guardar
          </LoadingButton>
        </div>
      </form>
    </Modal>
  )
}
