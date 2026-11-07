# NotiHouse-Pal — Frontend

React + TypeScript + Vite. Consume la API real desplegada en Render
(`https://notihouse-pal-api.onrender.com/api/v1`) — no requiere Docker, n8n
ni Neon para desarrollar.

**Antes de tocar nada, lee** `docs/frontend/GUIA_FRONTEND_NOTIHOUSE_PAL.md`
en la raíz del repositorio: es la fuente de verdad de contratos, seguridad,
flujos y protocolo de pruebas seguras.

## Arrancar

```bash
npm install
cp .env.example .env.local   # no se versiona
npm run dev                  # puerto 5173 fijo — único origen autorizado hoy en CORS
```

## Estado

Scaffold inicial (rama `feature/frontend-base`): cliente HTTP (`src/lib/api`),
sesión JWT sin refresh (`src/lib/auth`), rutas protegidas y páginas de
Login/Dashboard como placeholders funcionales sin diseño todavía. La
identidad visual (paleta, tipografía, layout del sidebar, animaciones) se
porta desde el mockup del equipo en un paso posterior, antes de construir
cada pantalla real.

## Scripts

| Script | Qué hace |
|---|---|
| `npm run dev` | Servidor de desarrollo (puerto 5173, `strictPort`) |
| `npm run build` | `tsc -b && vite build` |
| `npm run lint` | `oxlint` |
| `npm run preview` | Sirve el build de producción localmente |
