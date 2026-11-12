import { zodResolver } from '@hookform/resolvers/zod'
import { useForm } from 'react-hook-form'
import { z } from 'zod'
import { LoadingButton } from '../../components/Feedback'
import { Modal } from '../../components/Modal'
import { useToast } from '../../components/Toasts'
import { ApiError } from '../../lib/api/errors'
import { friendlyError } from '../../lib/api/messages'
import { useCreateProperty, useUpdateProperty } from './hooks'
import type { Property } from '../../lib/api/types'

const schema = z.object({
  name: z.string().trim().min(1, 'Ingresa un nombre').max(120),
  address: z.string().trim().max(300).optional().or(z.literal('')),
  description: z.string().trim().max(1000).optional().or(z.literal('')),
})
type FormValues = z.infer<typeof schema>

export function PropertyFormModal({ property, onClose }: { property?: Property; onClose: () => void }) {
  const create = useCreateProperty()
  const update = useUpdateProperty()
  const isEdit = !!property
  const {
    register,
    handleSubmit,
    setError,
    formState: { errors, isSubmitting },
  } = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { name: property?.name ?? '', address: property?.address ?? '', description: property?.description ?? '' },
  })

  const toast = useToast()
  async function onSubmit(values: FormValues) {
    try {
      if (isEdit) {
        await update.mutateAsync({
          id: property.id,
          input: {
            name: values.name,
            address: values.address || null,
            description: values.description || null,
          },
        })
      } else {
        await create.mutateAsync({
          name: values.name,
          address: values.address || undefined,
          description: values.description || undefined,
        })
      }
      toast.success(isEdit ? 'Cambios guardados.' : 'Inmueble registrado.')
      onClose()
    } catch (err) {
      if (err instanceof ApiError && err.status === 409) {
        setError('name', { message: 'Ya existe un inmueble con ese nombre' })
      } else {
        setError('name', { message: friendlyError(err, 'save') })
      }
    }
  }

  return (
    <Modal title={isEdit ? 'Editar inmueble' : 'Registrar inmueble'} onClose={onClose}>
      <form onSubmit={handleSubmit(onSubmit)} noValidate>
        <div className="field">
          <label htmlFor="name">Nombre</label>
          <input id="name" {...register('name')} aria-invalid={!!errors.name} />
          {errors.name && <span className="field-error" role="alert">{errors.name.message}</span>}
        </div>
        <div className="field">
          <label htmlFor="address">Dirección (opcional)</label>
          <input id="address" {...register('address')} />
        </div>
        <div className="field">
          <label htmlFor="description">Descripción (opcional)</label>
          <textarea id="description" rows={3} {...register('description')} />
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
