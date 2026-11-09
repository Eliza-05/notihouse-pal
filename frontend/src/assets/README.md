# Convención de `frontend/src/assets/`

Imágenes que el código **importa** y Vite empaqueta/hashea en el build
(diferente de `docs/frontend/` o de material que solo es referencia visual
para implementar, nunca enviado al navegador).

```
assets/
├─ backgrounds/     # fondos a pantalla completa (landing, login, hero...)
├─ brand/           # logo, isotipo, favicon-source, cualquier activo de marca
└─ illustrations/   # ilustraciones decorativas, estados vacíos, etc.
```

**Nomenclatura:** `PascalCase` descriptivo por pantalla/uso
(`LandingBackground.png`, `LoginBackground.png`, `DashboardEmptyState.svg`).
Si un mismo activo tiene variantes claro/oscuro, sufijo `-dark`
(`LandingBackground-dark.png`).

**Uso en código:** importar siempre como módulo, nunca referenciar por ruta
de texto suelta:

```tsx
import landingBg from '../assets/backgrounds/LandingBackground.png'
```

**No va aquí:** iconos (se usan de `lucide-react`, ya instalado) ni nada
que no se vaya a renderizar en producción — eso es `docs/frontend/`.
