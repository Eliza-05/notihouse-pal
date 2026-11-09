# Entorno QA local aislado

Todo corre en tu equipo con **datos ficticios y secretos aleatorios** (`.local/qa/qa.env`, ignorado por Git).
**No** usa Neon, Render, Vercel, `backend/.env` ni ningún contenedor preexistente. Gemini y Gmail están **simulados**
(`mock-gemini.mjs`): ningún resultado de este entorno cuenta como prueba con servicios reales.

| Servicio | Dónde |
|---|---|
| PostgreSQL 18 desechable | `127.0.0.1:55433` (volumen `notihouse-qa-pg`) |
| n8n Community 2.46.6 | `http://127.0.0.1:5679` (volumen `notihouse-qa-n8n`, proyecto `notihouse-qa`) |
| Backend NestJS | `http://localhost:3100` (arranca desde `.local/qa/run`, sin `.env`) |
| Frontend (Vite) | `http://127.0.0.1:5174` |
| Gemini simulado | `http://127.0.0.1:3200` (desde Docker: `host.docker.internal:3200`) |

## Puesta en marcha (desde la raíz del repo)

```bash
node infra/qa/generate-qa-env.mjs                      # secretos locales (no se muestran)
docker compose -p notihouse-qa -f infra/qa/docker-compose.qa.yml --env-file .local/qa/qa.env up -d --wait
(cd backend && npm ci && npm run build)
node --env-file=.local/qa/qa.env infra/qa/reset-qa.mjs  # migra (0000–0004) + seed oficial + credenciales nuevas
node --env-file=.local/qa/qa.env infra/qa/start-backend.mjs &   # reiniciar tras cada reset
node infra/qa/mock-gemini.mjs &
(cd frontend && npm ci && VITE_API_BASE_URL=http://localhost:3100/api/v1 npx vite --port 5174 --host 127.0.0.1) &
```

n8n (una sola vez): crear el propietario (`POST /rest/owner/setup`) y las credenciales **por nombre** que el importador resuelve:
`NotiHouse-Pal API (servicio)` (Header Auth: `Authorization: Bearer <QA_N8N_SERVICE_TOKEN>`) y
`Google Gemini(PaLM) Api account` (clave ficticia; `host` = Gemini simulado). Después:

```bash
for w in 02-procesamiento-documental 03-cierre-hitl 04-procesamiento-voz 06-mantenimiento-programado; do
  node n8n/tools/import-workflow.mjs n8n/workflows/$w.json --container notihouse-qa-n8n \
    --api-base http://host.docker.internal:3100/api/v1 --gemini-base http://host.docker.internal:3200 --qa-authorize
done
```

`--qa-authorize` solo cambia la **copia importada** (nunca el JSON del repo) y exige un `--api-base` local. Los workflows
quedan inactivos; las ejecuciones son manuales (`docker exec notihouse-qa-n8n n8n execute --id <id>`).

## Escenarios

```bash
node --env-file=.local/qa/qa.env infra/qa/run-all.mjs      # 10 escenarios, 152 comprobaciones (base limpia)
```

Las contraseñas de las cuentas ficticias están en `.local/qa/qa.env` (`QA_USER_PASSWORD_*`). Para iniciar sesión en el
navegador usa esas variables; **no las copies a ningún archivo versionado**.
Cada ejecución **manual** de los workflows 02/04 gasta 1 llamada de sondeo a Gemini; aquí es el simulado.

## Destruir

```bash
docker compose -p notihouse-qa -f infra/qa/docker-compose.qa.yml --env-file .local/qa/qa.env down -v   # solo este proyecto
```
