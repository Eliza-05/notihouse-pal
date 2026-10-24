# NotiHouse-Pal

Asistente inteligente para la gestión financiera del hogar y de inmuebles en arriendo, basado en hiperautomatización y agentes de inteligencia artificial con supervisión humana.

> **Estado (Fase 3):** el **backend** (NestJS) se ejecuta localmente y ya está conectado a **Neon PostgreSQL** mediante Drizzle ORM: el esquema relacional y la migración inicial están aplicados. Por ahora la API solo expone un endpoint de salud. Aún no hay endpoints CRUD, autenticación, n8n, frontend, integraciones externas ni despliegues.

## Descripción

NotiHouse-Pal está dirigido a personas que administran las obligaciones financieras recurrentes de su hogar y de uno o varios inmuebles en arriendo. Su propósito es centralizar esa información, vigilar vencimientos y apoyar la toma de decisiones, manteniendo siempre a la persona usuaria en control de las acciones sensibles.

## Objetivo del MVP

Se prevé que el MVP permita:

- Registrar y administrar obligaciones recurrentes (electricidad, agua, gas, internet, administración).
- Consultar fechas de vencimiento, valores y estados.
- Registrar inmuebles, arriendos y contratos.
- Hacer seguimiento a cobros pendientes y vencimientos contractuales.
- Procesar facturas a partir de archivos o de correos de Gmail autorizados.
- Interpretar notas de voz mediante un servicio de transcripción (STT).
- Usar un agente de IA para interpretar información, generar resúmenes y preparar recomendaciones.
- Generar alertas y recordatorios mediante reglas determinísticas.
- Solicitar aprobación humana (HITL) ante información contradictoria o decisiones sensibles.

### Restricciones de diseño

- El agente de IA **no** realiza pagos, transferencias ni movimientos financieros, **no** modifica contratos y **no** envía comunicaciones sensibles de forma autónoma.
- Gmail se utiliza exclusivamente con permisos de **lectura**.
- Los datos interpretados por IA deben superar validaciones antes de almacenarse como información definitiva.
- El backend controla el acceso a la fuente de verdad.
- Las operaciones relevantes tendrán trazabilidad mediante identificadores de caso (`correlation_id`), estados y registros de auditoría.

## Arquitectura tecnológica

| Componente | Tecnología | Despliegue previsto |
|---|---|---|
| Frontend | React + TypeScript + Vite | Vercel |
| Backend | NestJS + TypeScript (API REST) | Render |
| Base de datos | PostgreSQL | Neon |
| Automatización | n8n Community Edition | Docker local (migración posterior posible) |

Servicios externos previstos (se incorporarán gradualmente; aún no configurados):

- Gmail API mediante OAuth (solo lectura).
- Modelo LLM para interpretación y generación.
- Servicio de transcripción de voz (STT).
- Firebase Cloud Messaging para notificaciones.

### Responsabilidad de cada componente

- **Frontend:** interfaz de usuario para consultar y gestionar obligaciones, inmuebles y contratos, y para revisar y aprobar las solicitudes HITL.
- **Backend:** autenticación, autorización, acceso a datos, validación de la información interpretada por IA, auditoría y comunicación autenticada con n8n. Es el único componente con acceso directo a la fuente de verdad.
- **Base de datos:** fuente de verdad del sistema. Esquema y migraciones versionados en `database/migrations`. Diseño en [docs/architecture/database-design.md](docs/architecture/database-design.md).
- **n8n:** orquestación de flujos de automatización (ingesta de facturas, transcripción, invocación del LLM, recordatorios). Se integra con el backend mediante solicitudes HTTP autenticadas. Los workflows se versionan como archivos JSON.

## Estructura del repositorio

```text
notihouse-pal/
├── frontend/              # Aplicación React + Vite (pendiente)
├── backend/               # API REST NestJS (inicializada: endpoint de salud)
├── database/
│   └── migrations/        # Migraciones SQL versionadas (Drizzle Kit)
├── n8n/
│   └── workflows/         # Exportaciones JSON de workflows de n8n
├── infra/
│   └── n8n/               # Configuración de infraestructura local de n8n (Docker)
├── docs/
│   ├── architecture/      # Documentación de arquitectura
│   ├── api/               # Documentación de la API
│   └── testing/           # Estrategia y evidencias de pruebas
├── .env.example           # Plantilla de variables de entorno
├── .gitignore
├── LICENSE
└── README.md
```

Los archivos `.gitkeep` son marcadores temporales para versionar carpetas vacías y se eliminarán cuando contengan archivos reales.

## Estado actual del desarrollo

| Área | Estado |
|---|---|
| Estructura del monorepositorio | Creada |
| Frontend | No iniciado |
| Backend | Inicializado (Fase 2): configuración de entorno, CORS, Swagger, módulos base y `GET /api/v1/health`. Módulo de base de datos con Drizzle (Fase 3). Sin autenticación, CRUD ni lógica de negocio. |
| Esquema y migraciones de base de datos | Fase 3: 15 tablas, migración inicial `0000_initial_schema` aplicada en Neon (rama `production`, base `neondb`), sin datos |
| Workflows de n8n | No iniciado |
| Infraestructura Docker | No iniciada |
| Integraciones externas (Gmail, LLM, STT, FCM) | No iniciadas |
| Despliegues (Vercel, Render) | No configurados |

## Backend: inicio rápido

```bash
cd backend
npm ci
cp .env.example .env      # completar DATABASE_URL y DATABASE_URL_DIRECT
npm run db:check          # verificar conexión con Neon (solo lectura)
npm run start:dev
```

- Salud: `GET http://localhost:3000/api/v1/health`
- Swagger (fuera de producción): <http://localhost:3000/api/docs>

La guía completa está en [docs/api/backend-setup.md](docs/api/backend-setup.md).

## Requisitos técnicos previstos

Las versiones exactas se fijarán al iniciar cada componente.

- Node.js `^22.22.3`, `^24.15.0` o `>=26` (se recomienda la LTS 24.x) y npm.
- Git.
- Docker y Docker Compose (para ejecutar n8n localmente).
- Cadenas de conexión de Neon (`DATABASE_URL` y `DATABASE_URL_DIRECT`), solicitadas a la persona responsable del proyecto.
- Cuentas en Vercel, Render y Neon para los despliegues.

## Variables de entorno y credenciales

- La plantilla [`.env.example`](.env.example) documenta las variables previstas **sin valores reales**. Cada componente tiene además su propia plantilla (p. ej. [`backend/.env.example`](backend/.env.example)).
- Para trabajar localmente, copia la plantilla como `.env` y completa los valores. El archivo `.env` está excluido del control de versiones.
- **Nunca** subas al repositorio credenciales, claves de API, tokens OAuth, cadenas de conexión reales ni archivos de cuentas de servicio.
- Los secretos de los entornos desplegados se configurarán directamente en cada plataforma (Vercel, Render, Neon, n8n).

## Licencia

Distribuido bajo la licencia MIT. Consulta [LICENSE](LICENSE).
