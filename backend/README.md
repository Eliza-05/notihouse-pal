# NotiHouse-Pal API (backend)

API REST de NotiHouse-Pal construida con NestJS y TypeScript.

```bash
npm ci
cp .env.example .env      # completar DATABASE_URL y DATABASE_URL_DIRECT
npm run db:check          # verificar conexión con Neon (solo lectura)
npm run start:dev
```

- Salud: `GET http://localhost:3000/api/v1/health`
- Swagger (solo fuera de producción): <http://localhost:3000/api/docs>

La guía completa (requisitos, variables de entorno, scripts y pruebas) está en [docs/api/backend-setup.md](../docs/api/backend-setup.md).
