# Autenticación

Diseño de la autenticación de NotiHouse-Pal, implementada en la Fase 4.1.

> **Alcance actual:** hay inicio de sesión, JWT, un guard global, `GET /auth/me` y cuatro usuarios de demostración. Desde las Fases 4.2A, 4.2B y 4.2C, los endpoints de inmuebles, obligaciones, períodos, arriendos, cobros, contratos, casos y revisiones HITL aplican y prueban la autorización por propietario ([business-api.md](../api/business-api.md)). Las rutas `/internal/*` usan un **token de servicio** separado de los JWT de usuario ([workflow-integration.md](../api/workflow-integration.md#2-autenticación-del-servicio)).

## 1. Decisiones

- **Acceso cerrado.** No hay registro público, recuperación de contraseña, refresh tokens, login con Google ni panel de administración de usuarios. Las cuentas las crea el equipo.
- **Autenticación local:** correo + contraseña, contraseñas con **Argon2id** y sesión con **JWT** de 30 minutos.
- **Privado por defecto.** Un guard global exige token en todas las rutas, salvo las marcadas con `@Public()`.
- **La identidad sale solo del token.** El propietario de los datos es siempre el `profileId` autenticado. Nunca se acepta un `ownerId` o `userId` enviado por el cliente.
- **Cierre de sesión:** el frontend descarta el token. No existe un endpoint `logout`, porque no hay un mecanismo real de revocación de tokens individuales (ver "Limitaciones").

## 2. Cuentas y perfiles

```text
profiles (1) ──── (0..1) auth_accounts
  id  ◄──────────────── profile_id (UNIQUE, FK ON DELETE RESTRICT)
  display_name           email (UNIQUE, normalizado)
  external_auth_id       password_hash (Argon2id, PHC)
                         is_active
                         password_changed_at
```

| Columna de `auth_accounts` | Regla |
|---|---|
| `profile_id` | FK a `profiles`, única: una cuenta por perfil. Un perfil con cuenta no se puede borrar. |
| `email` | `UNIQUE`. El check `auth_accounts_email_normalized` exige `email = lower(btrim(email))`, así que dos cuentas no pueden diferir solo en mayúsculas o espacios. El check `auth_accounts_email_format` valida la forma básica. |
| `password_hash` | El check `auth_accounts_password_hash_argon2id` exige el prefijo `$argon2id$`. La base de datos rechaza contraseñas en claro u otros algoritmos. |
| `is_active` | Las cuentas no se borran: se desactivan. Una cuenta inactiva no puede iniciar sesión y sus tokens dejan de funcionar al instante. |
| `password_changed_at` | Se rechazan los tokens emitidos antes de esta fecha. Así, cambiar una contraseña invalida las sesiones anteriores. |

- **Datos duplicados:** el correo vive solo en `auth_accounts` y el nombre visible en `profiles`.
- **`profiles.external_auth_id`:** queda reservado para un proveedor de identidad externo futuro. La autenticación local no lo usa y no existe ningún proveedor externo configurado.

Migración: `database/migrations/0001_auth_accounts.sql`, puramente aditiva.

## 3. Contraseñas

- Argon2id con la configuración mínima recomendada por OWASP: `m = 19456 KiB (19 MiB)`, `t = 2`, `p = 1`, con salt aleatorio por hash. Usa el paquete `argon2` (node-argon2) con binarios precompilados para Windows y Linux.
- Las contraseñas de las cuentas demo son aleatorias (18 bytes, 24 caracteres en base64url) y distintas entre sí. No están en el código ni en la documentación.
- **Tiempo de respuesta uniforme:** si el correo no existe, se verifica igualmente contra un hash descartable. Así, el tiempo de respuesta no revela si la cuenta existe.
- La entrada se limita a 256 caracteres para acotar el costo de la verificación.

## 4. Endpoints

Prefijo `/api/v1`. Están documentados en Swagger (`/api/docs`, solo fuera de producción), con el esquema de seguridad `bearer`.

### `POST /auth/login` (público, con rate limiting)

```json
{ "email": "laura.martinez@notihouse.com", "password": "••••••••" }
```

| Caso | Respuesta |
|---|---|
| Credenciales correctas y cuenta activa | **200** `{ accessToken, tokenType: "Bearer", expiresIn: 1800, user: { id, email, displayName } }` |
| Contraseña incorrecta, correo inexistente o cuenta inactiva | **401** `"Credenciales inválidas"`. Es exactamente la misma respuesta en los tres casos. |
| Correo mal formado, contraseña vacía, tipos incorrectos, propiedades extra (p. ej. `ownerId`) | **400**. El `ValidationPipe` global usa `whitelist` y `forbidNonWhitelisted`. |
| Más de 5 intentos por minuto desde la misma IP | **429** |

El correo se normaliza (`trim` + minúsculas) antes de buscarlo. La respuesta nunca incluye el hash ni datos financieros.

### `GET /auth/me` (privado)

Requiere `Authorization: Bearer <token>`. Devuelve `{ id, email, displayName }` del usuario cuyo `sub` está en el token, después de validarlo contra la base de datos. Los parámetros de consulta o cabeceras como `userId` o `X-User-Id` se ignoran.

### Rutas públicas

Solo `GET /health` y `POST /auth/login`. Swagger no pasa por el guard porque no es un controlador, y solo se monta cuando `NODE_ENV ≠ production`. Cualquier controlador nuevo queda **privado** automáticamente.

## 5. JWT

| Parámetro | Valor |
|---|---|
| Algoritmo | `HS256`. Al verificar solo se acepta HS256, así que `alg: none` y otros algoritmos se rechazan. |
| Secreto | `JWT_SECRET`: obligatorio fuera de `test`, mínimo 43 caracteres (32 bytes aleatorios). Se rechazan valores de ejemplo y de baja entropía. |
| Vencimiento | 1800 s (30 min), sin refresh tokens |
| `sub` | UUID del perfil (`profiles.id`) |
| `iss` | `notihouse-pal-api` |
| `aud` | `notihouse-pal-web` |
| Contenido | Solo `sub`, `iat`, `exp`, `iss`, `aud`. Sin correo, contraseña ni datos financieros. |

### Validación en cada petición (`JwtAuthGuard`)

| Situación | Respuesta |
|---|---|
| Sin cabecera `Authorization`, o con un esquema distinto de `Bearer` | 401 |
| Firma inválida, token modificado, expirado, emisor o audiencia incorrectos | 401 |
| `sub` que no es un UUID | 401 |
| Perfil inexistente, cuenta inactiva o token anterior a `password_changed_at` | 401 |
| La base de datos no responde | **503**. El acceso se deniega: nunca se permite por omisión. |

Si todo es válido, el guard deja en `request.user` un `AuthenticatedUser { profileId, email, displayName }`.

## 6. Uso en los módulos de negocio

```ts
@Get()
list(@CurrentUser() user: AuthenticatedUser) {
  return this.service.listFor(user.profileId); // owner_id = user.profileId, siempre
}
```

- Los DTO de creación y edición **no** deben declarar `ownerId`. El `ValidationPipe` rechaza cualquier propiedad no declarada.
- Toda consulta de lectura, edición o borrado debe filtrar por `owner_id = user.profileId`. Las FKs compuestas `(id, owner_id)` de PostgreSQL impiden mezclar entidades de distintos propietarios, pero **no sustituyen** este filtro de autorización.
- Implementado y probado para inmuebles, obligaciones y períodos (Fase 4.2A) y para arriendos, cobros y contratos (Fase 4.2B), casos y revisiones HITL (Fase 4.2C). Los módulos futuros deben seguir el mismo patrón y sus propias pruebas de aislamiento.

## 7. Usuarios de demostración

| Usuario | Correo | Propósito | Datos ficticios iniciales |
|---|---|---|---|
| Laura Martínez | `laura.martinez@notihouse.com` | Obligaciones y servicios | 1 inmueble; obligaciones de energía, agua e internet; 4 períodos `pending` |
| Andrés Gómez | `andres.gomez@notihouse.com` | Arriendos y cobros | 1 inmueble; 1 arriendo activo; 2 cobros `expected`; 1 obligación de administración con 1 período `pending` |
| Camila Torres | `camila.torres@notihouse.com` | Contratos y vencimientos | 1 inmueble; 1 arriendo; 1 contrato del 2025-12-16 al 2026-12-15 con 30 días de preaviso (para probar alertas) |
| Daniel Rojas | `daniel.rojas@notihouse.com` | Pruebas de voz, IA y documentos | 1 inmueble; 1 obligación de gas con 1 período `pending` |

Los correos `@notihouse.com` son **solo identificadores de inicio de sesión**. El sistema no envía mensajes a esas direcciones, no las verifica ni las usa para recuperar cuentas, y el equipo no asume ser propietario del dominio.

Todo está en estados iniciales legítimos:
- No hay pagos confirmados, cobros recibidos ni alertas.
- No hay documentos, propuestas de IA ni casos.
- No se crean proveedores ni enlaces de pago (las URL de pago nunca se inventan).
- Cada cuenta creada genera un evento `auth_account.create` en `audit_events` (actor `system`, `seed-demo`).

### Ejecutar el seed (`npm run db:seed:demo`)

Antes de escribir, el script comprueba:

1. `NODE_ENV=development`. Rechaza `production`, y también Render o CI (`RENDER`, `CI`).
2. Que las migraciones aplicadas coinciden con las versionadas.
3. Que la base solo contiene datos administrados por el seed:
   - Ninguna cuenta que no sea demo.
   - Ningún perfil sin cuenta demo.
   - Ninguna fila de negocio ni de auditoría de otro propietario.
   - Catálogo de proveedores vacío.

   Si algo falla, se cancela sin escribir.
4. Que el archivo de credenciales está excluido por Git (`git check-ignore`).

Funcionamiento:
- **Idempotente:** crea solo las cuentas que faltan. Si las cuatro existen, termina sin cambios. Nunca regenera ni reemplaza contraseñas.
- **Atómico:** perfiles, cuentas, datos y auditoría se crean en una sola transacción. Si alguna cuenta ya existe, la restricción `UNIQUE` aborta todo.
- **No imprime** contraseñas, hashes ni cadenas de conexión.

### Actualización de identidades (`npm run db:demo:update-identities`)

Las cuentas creadas por versiones anteriores del seed tenían los correos `hogar@`, `arriendos@`, `contratos@` e `integracion@notihouse.test`. El seed actual las detecta y se niega a continuar hasta que se actualicen; nunca las recrea.

El script `db:demo:update-identities` las renombra **en el mismo lugar**, dentro de una transacción:

- Exige que existan exactamente esas cuatro cuentas y ninguna otra. Si no, aborta sin escribir.
- Conserva los UUID de perfiles y cuentas y todos los datos de negocio. No toca ningún `owner_id` ni estado.
- Actualiza `profiles.display_name` y `auth_accounts.email`, y genera un hash Argon2id **independiente por cuenta** (salt distinto aunque la contraseña sea la misma).
- Renueva `password_changed_at`, lo que invalida los JWT anteriores.
- Registra un evento `auth_account.identity_update` por cuenta, con el correo anterior y el nuevo. Nunca registra contraseñas ni hashes.
- Recibe la contraseña **solo** por la variable de entorno temporal `DEMO_ACCOUNTS_PASSWORD`, que el proceso retira de su entorno al leerla. No se acepta como argumento, no se lee de archivos versionados y no se imprime.
- Después del commit, reescribe `backend/.local/demo-credentials.txt` en el mismo lugar, sin copias y conservando su ACL.

Se ejecutó una vez sobre Neon el 2026-10-24.

**Contraseña temporal compartida.** Por decisión del MVP académico, las cuatro cuentas actuales comparten temporalmente una misma contraseña de demostración, guardada solo en el archivo local y nunca en el código ni en la documentación. **No es adecuada para un backend accesible desde Internet.** Antes de cualquier despliegue público debe sustituirse por contraseñas únicas y seguras. En una instalación nueva, el seed sigue generando una contraseña aleatoria distinta por cuenta.

### Credenciales locales

- Las contraseñas generadas se guardan **solo** en `backend/.local/demo-credentials.txt`, ignorado por Git mediante la regla `.local/`. Si el archivo ya existe, se crea `demo-credentials-<fecha>.txt`, sin sobrescribir.
- El archivo se crea antes de la transacción. Si no se puede escribir o proteger, no se crea ninguna cuenta. Si la transacción falla, el archivo se borra.
- **Permisos:** en Windows se retira la herencia y se concede acceso solo al usuario actual (`icacls`). En Linux y macOS se usa el modo `0600`.
- **Es temporal.** Guarda las credenciales en un gestor de contraseñas, compártelas con el equipo solo por un canal privado y luego elimina el archivo. No se deben poner como valores por defecto en el frontend.
- **OneDrive:** si el repositorio está en una carpeta sincronizada (como OneDrive), `.local/` y `.env` también se sincronizan con esa nube personal, aunque no con Git.

## 8. Rate limiting

- Usa `@nestjs/throttler` solo en `POST /auth/login`: 5 intentos por minuto por IP. A partir del sexto responde 429.
- El almacenamiento es **en memoria**: funciona para **una instancia** y se reinicia al reiniciar el proceso. Con varias instancias, habrá que usar un almacenamiento compartido (por ejemplo, Redis) o un limitador en el borde.
- Detrás del proxy de Render, `req.ip` será la IP del proxy salvo que se configure `trust proxy`. Es un ajuste pendiente para el despliegue.

## 9. Pruebas

| Archivo | Qué cubre |
|---|---|
| `src/auth/password.spec.ts` | Formato y parámetros Argon2id, salt aleatorio, verificación, hash corrupto, hash descartable |
| `src/auth/jwt-auth.guard.spec.ts` | Extracción del Bearer, rutas públicas, fallo de base de datos → 503 sin identidad, `sub` no UUID |
| `src/config/env.validation.spec.ts` | `JWT_SECRET` obligatoria, demasiado corta, de ejemplo o de baja entropía, sin repetir su valor en los errores |
| `src/database/seed/demo-seed.spec.ts` | Seed en PGlite: plan, datos y estados, propietarios, solo hashes, idempotencia, que no sobrescribe, que se niega ante datos ajenos; restricciones de `auth_accounts` |
| `test/auth.e2e-spec.ts` | Aplicación Nest completa sobre PGlite: login (éxito, normalización, 401 idénticos, 400 de validación, 429), JWT (modificado, otra firma, expirado, emisor, audiencia, `alg: none`, perfil inexistente, cuenta desactivada, cambio de contraseña), aislamiento de identidad, superficie pública y Swagger |

- Las pruebas usan un `JWT_SECRET` aleatorio por ejecución (`test/setup-env.ts`), nunca el real.
- No se conectan a Neon.

## 10. Limitaciones y requisitos antes del despliegue público

1. **Rol PostgreSQL limitado.** Hoy la API se conecta como `neondb_owner`. Antes de publicar en Render hay que:
   - crear un rol de aplicación con privilegios mínimos (sin DDL, sin `TRUNCATE`, sin acceso a `drizzle.*`);
   - dejar `neondb_owner` solo para administración y migraciones (`DATABASE_URL_DIRECT`).
2. **Row-Level Security:** evaluarla como defensa adicional sobre `owner_id`. No está activada.
3. **Autorización por propietario** en todos los endpoints de negocio, con pruebas (Fase 4.2).
4. **Revocación:** no hay lista de revocación. La desactivación de cuentas y `password_changed_at` invalidan tokens, y la duración máxima de una sesión es de 30 minutos.
5. **Rate limiting** en memoria: ver la sección 8. Falta configurar `trust proxy` en Render.
6. **Rotación de `JWT_SECRET`:** cambiarlo invalida todos los tokens. En Render se definirá como variable secreta de la plataforma.
7. **Cambio de contraseña:** no hay endpoint. Si hace falta, se hará con un script administrativo que actualice el hash y `password_changed_at`.
8. **Contraseña demo compartida:** las cuatro cuentas actuales comparten una contraseña temporal (ver sección 7). Hay que reemplazarla por contraseñas individuales antes de publicar el backend.
9. **Granularidad de la invalidación:** `iat` se expresa en segundos. Un token emitido en el mismo segundo en que se cambia la contraseña, pero antes del cambio, seguiría siendo válido hasta expirar (máximo 30 minutos). Los tokens de segundos anteriores se rechazan, como se comprobó contra Neon. Es una limitación aceptada para el MVP.
