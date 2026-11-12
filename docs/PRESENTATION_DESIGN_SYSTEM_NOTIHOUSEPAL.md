# NotiHouse-Pal — Sistema de diseño para la presentación de sustentación

> Extraído del frontend real (no es una identidad nueva). Fecha de análisis: 2026-11-11.
> Fuentes: `frontend/src/components/tokens.css`, `AppShell.css`, `Modal.css`, `Toasts.css`, `Feedback.css`, `NotificationBell.css`, `features/landing/landing.css`, `features/auth/login.css`, `features/cases/review.css`, `public/favicon.svg`, `src/assets/backgrounds/LandingBackground.png`.

## 0. Cómo se obtuvo y qué tan exacto es

| Dato | Origen | Certeza |
|---|---|---|
| Colores, sombras, radios, blur, tipografías, bordes, espaciado | Leídos literalmente de los CSS (variables `--*`) | **Exacto** |
| Landing y Login | Renderizados en el navegador local (`localhost:5173`) | **Verificado visualmente** |
| Pantallas autenticadas (resumen, bandeja, HITL, obligaciones, documentos, solicitudes) | Requieren sesión; no se abrieron con datos reales. Se renderizó una **maqueta estática con los CSS reales** (sidebar, KPIs, lista, badges, botones, toast) en claro y oscuro | **Verificado para el sistema de componentes**; la composición exacta de cada pantalla se infiere del código |
| Color "efectivo" de los brillos de esquina (blobs difuminados) | Calculado mezclando color × opacidad 0.55 sobre el fondo | **Estimado** (marcado con ≈) |
| Ratios de contraste | Calculados con la fórmula WCAG 2.x sobre los HEX | **Exacto** (sobre fondos sólidos) |
| Equivalencias en pt / pulgadas para PowerPoint | Convertidas por proporción desde la app | **Estimado** |

Hallazgo clave: el producto tiene **dos lienzos** que conviven y la presentación debe usar ambos con intención.

1. **Lienzo cinematográfico** (Landing + Login): negro `#0A0A0C` → rojo intenso, foto de llaves y libreta, Inter, botón píldora blanco. Es la "puerta de entrada".
2. **Lienzo de producto** (app autenticada): cálido, vidrio, rojo/ámbar, Manrope + Public Sans + JetBrains Mono, modo claro y oscuro. Es "el producto".

---

## A. Diagnóstico visual

- **Personalidad:** confiable, cálida y de control. Es "el asistente de la casa que no se te olvida de nada": cercano, pero serio con el dinero. Un fintech doméstico, no un ERP.
- **Sensaciones:** calma con urgencia medida (el rojo señala, no grita), orden, transparencia, "tengo el control". La profundidad suave comunica cuidado y premium.
- **Formalidad:** media-alta. Tono sobrio, títulos firmes (Manrope 800), cifras monoespaciadas (dato verificable). Sin ilustraciones infantiles ni emojis.
- **Tipo de interfaz:** dashboard de gestión con **sidebar "isla" flotante**, tarjetas de vidrio, píldoras de estado, listas con icono, KPIs con barra de progreso, modales y toasts. En móvil, dock inferior en píldora.
- **Qué lo hace distintivo:**
  1. Rojo carmesí con degradado diagonal `#E23B52 → #9E1B30` como **única firma de acción**.
  2. Fondo **ambiental**: tres manchas difuminadas (rojo/ámbar/rosa) en esquinas que flotan lentamente.
  3. **Vidrio** (blur + saturación) con bordes muy curvos (26 px) y sombras teñidas de rojo, no grises.
  4. Pareja **rojo + ámbar** (nunca azul como color de marca; el azul solo es "info").
  5. Pills de estado con **punto luminoso** (halo de 3 px).
  6. Resorte (`cubic-bezier(.34,1.56,.64,1)`) en los movimientos: todo "rebota" suavemente.

---

## B. Tokens visuales reales

### B.1 Paleta principal (marca)

| Token | Nombre sugerido | Claro | Oscuro | Uso |
|---|---|---|---|---|
| `--accent` | Carmesí HousePal | `#C4223B` | `#FF5A72` | Enlaces, foco, acento, texto de marca |
| `--accent-bright` | Carmesí vivo | `#E23B52` | `#FF7A8C` | Inicio del degradado, barras |
| `--accent-ink` | Granate | `#9E1B30` | `#FF97A6` | Fin del degradado, texto sobre tinte rojo, sombras |
| `--accent-2` | Ámbar | `#B45309` | `#F0A860` | Secundario/cálido, fin de barras, "warn" |
| (favicon/brand) | Degradado de marca | `#E23B52 → #9E1B30` | igual | Botón primario, insignia, nav activo, campana |

### B.2 Paleta secundaria y de estado

| Estado | Token | Claro | Oscuro | Fondo suave (claro / oscuro) |
|---|---|---|---|---|
| Éxito / aplicada | `--good` | `#4C8B5F` | `#6FCB8A` | `rgba(76,139,95,.12)` / `rgba(111,203,138,.15)` |
| Advertencia / pendiente | `--warn` | `#B45309` | `#F0A860` | `rgba(180,83,9,.12)` / `rgba(240,168,96,.15)` |
| Error / crítico / vencido | `--critical` | `#9E1B30` | `#FF7A8C` | `rgba(196,34,59,.13)` / `rgba(255,122,140,.16)` |
| Info / en revisión | `--info` | `#2F5F9E` | `#8FB6F0` | `rgba(47,95,158,.11)` / `rgba(143,182,240,.15)` |
| Neutro / borrador | `--text-muted` sobre `--border-soft` | `#6E615E` | `#C7B3AE` | `rgba(158,27,48,.08)` / `rgba(255,150,150,.08)` |

Nota: el sistema no tiene un color "pendiente" propio; pendiente = ámbar (warn). Los bordes de las píldoras usan la versión `-strong` (opacidad .24–.32).

### B.3 Fondos

| Token | Claro | Oscuro |
|---|---|---|
| `--bg` | `#FFF8F6` (crema rosado) | `#170F0E` (marrón casi negro) |
| `--bg-2` | `#FDEEE9` | `#1E1412` |
| Fondo de página | `linear-gradient(160deg, bg, bg-2)` | igual |
| `--blob-a` (arriba-izq) | `#FF6B72` | `#B23048` |
| `--blob-b` (abajo-der) | `#FFB37B` | `#8A5A2A` |
| `--blob-c` (centro-der) | `#FFD9D3` | `#4A2420` |
| `--surface` (vidrio base) | `rgba(255,255,255,.50)` | `rgba(40,27,25,.55)` |
| `--surface-strong` | `rgba(255,255,255,.80)` | `rgba(48,33,30,.82)` |
| `--surface-solid` (modales, popovers) | `rgba(255,255,255,.94)` | `rgba(32,21,19,.96)` |
| Borde de vidrio `--border` | `rgba(255,255,255,.65)` | `rgba(255,255,255,.09)` |
| Línea `--line` | `rgba(158,27,48,.10)` | `rgba(255,170,170,.12)` |
| Hover/zebra `--border-soft` | `rgba(158,27,48,.08)` | `rgba(255,150,150,.08)` |

Color efectivo estimado de los brillos (mancha × 0.55 sobre el fondo, en el centro de la mancha, ≈):
- Claro: A ≈ `#FFAAAD`, B ≈ `#FECDAC`, C tenue. Dominante rosado-melocotón.
- Oscuro: A ≈ `#6C212E`, B ≈ `#593A1F`, C ≈ `#2F1C19`. Dominante vino y cobre.

Landing/Login (lienzo cinematográfico): `#0A0A0C` base, `#E82127` rojo, `#B5121B` rojo oscuro, `#F5F5F7` gris claro, `#86868B` gris, viñeta `radial-gradient(ellipse at 50% 55%, rgba(10,10,12,.35) → .62 → .78)`. Degradado de lectura izquierdo `linear-gradient(90deg, rgba(10,10,12,.55) 0%, .10 45%, transparent 65%)`.

### B.4 Texto

| Rol | Claro | Oscuro |
|---|---|---|
| Principal `--text` | `#241B1A` | `#F5E9E6` |
| Secundario `--text-muted` | `#6E615E` | `#C7B3AE` |
| Inactivo/etiqueta `--text-faint` | `#A69894` | `#8A7570` |
| Sobre degradado rojo | `#FFFFFF` (sub: blanco 78%) | `#FFFFFF` |
| Landing: texto / gris | `#FFFFFF` (sub 75%) / `#86868B` | — |

### B.5 Degradados

| Uso | Definición | Ángulo / colores |
|---|---|---|
| **Primario** (botón, nav activo, dock, campana, insignia, favicon) | `linear-gradient(155deg, #E23B52, #9E1B30)` | 155° (insignia y colapso 150°; favicon diagonal 135°) |
| Fondo de página | `linear-gradient(160deg, --bg, --bg-2)` | 160° casi vertical, muy sutil |
| Barra de progreso KPI | `linear-gradient(90deg, --accent-bright, --accent-2)` | Rojo → ámbar, horizontal |
| Avatar | `linear-gradient(150deg, --accent-2, --accent-bright)` | Ámbar → rojo |
| Texto del título hero (landing) | `linear-gradient(90deg, #fff, rgba(255,255,255,.7))` | Blanco → blanco 70% |
| Skeleton shimmer | `linear-gradient(90deg, transparent, --surface-strong, transparent)` | Brillo que cruza |

### B.6 Sombras (teñidas de granate en claro, negras en oscuro)

| Elemento | Claro | Oscuro |
|---|---|---|
| `--shadow-sm` (icon-btn, botón secundario) | `0 4px 18px rgba(158,27,48,.10)` | `0 4px 18px rgba(0,0,0,.35)` |
| `--shadow-md` (cards, tablas, sidebar, dock, toast) | `0 12px 40px rgba(158,27,48,.14)` | `0 12px 40px rgba(0,0,0,.45)` |
| `--shadow-lg` (modales, popovers, hojas) | `0 28px 70px rgba(158,27,48,.20)` | `0 28px 70px rgba(0,0,0,.55)` |
| Botón primario | `0 10px 24px rgba(158,27,48,.30)`; hover `0 12px 30px rgba(158,27,48,.42)` | igual |
| Insignia de marca | `0 8px 18px -6px rgba(158,27,48,.50)` | igual |
| Nav activo | `0 8px 20px rgba(158,27,48,.28)` | igual |
| Píldora (badge) | `0 1px 2px rgba(0,0,0,.05), inset 0 1px 0 rgba(255,255,255,.4)` | igual |
| Foco | outline 2 px `--accent`, offset 2 px; inputs: anillo `0 0 0 3px --accent-soft-strong` | igual |

### B.7 Vidrio, blur y transparencia

| Elemento | Blur / saturación |
|---|---|
| Cards, tablas, bloques de estado | `blur(22px) saturate(160%)` sobre `--surface` |
| Sidebar, dock, modal, popover de usuario, hoja móvil | `blur(26px) saturate(180%)` sobre `--surface-strong` / `--surface-solid` |
| Panel de campana | `blur(18px)` sobre `--surface-solid` |
| Overlay de modal | `rgba(23,15,14,.38)` + `blur(4px)` |
| Manchas de fondo | `filter: blur(80px)`, `opacity: .55`, círculos de 560/480/340 px |

Disposición de las manchas en 1440×810: A 560 px en (−120, −180) arriba-izquierda; B 480 px en (derecha −100, abajo −160); C 340 px a 40% alto / 55% ancho. Flotan 22–30 s (`translate` + `scale` 1.06–1.10).

### B.8 Radios, bordes, espaciado

| Elemento | Valor |
|---|---|
| `--radius-lg` (cards, sidebar, modal, tablas) | **26 px** |
| `--radius-md` (KPI móvil, popovers, toasts, hojas) | **18 px** |
| `--radius-sm` (inputs, filas, navegación, citas) | **12 px** |
| Insignia de marca / icono de fila | 14 px / 11 px |
| Botones, píldoras, dock, avatar, icon-btn | **999 px / 50%** (totalmente redondos) |
| Favicon | 16/64 = 25% |
| Bordes | **1 px** estándar; 2 px foco y punto de progreso; 3 px cita lateral; **4 px** borde izquierdo de toast (color de estado); `1px dashed` en estados vacíos |
| Padding de card | 20 × 21.6 px (`1.25rem 1.35rem`); KPI 18 × 20 px |
| Huecos | 14 px KPIs, 18 px entre sidebar y contenido, 16 px (1 rem) apilado, 12 px fila |
| Ancho útil | contenido máx. 1180 px, sidebar 256 px (80 px colapsada) |
| Ritmo | 4 → 6 → 8 → 12 → 14 → 18 → 26: escala suave, aire generoso |

### B.9 Tipografía

| Rol | Familia | Peso | Tamaño en app | Detalle |
|---|---|---|---|---|
| Títulos y cifras KPI | **Manrope** | 800 (700 en h3) | h1 20.8–25.6 px, h2 16.8 px, KPI 24–32 px | `letter-spacing: -0.01em` |
| Texto | **Public Sans** | 400–700 | 14–15 px (0.88–0.92rem) | Etiquetas 11–12 px |
| Cifras, montos, contadores | **JetBrains Mono** | 500–600 | 14 px | `tabular-nums` |
| Etiquetas | Public Sans | 700 | 11–12 px, MAYÚSCULAS, `letter-spacing .06em` | color `--text-faint` |
| Landing / Login | **Inter** | 800 título (60 px, −2.2 px) | 18 px subtítulo, 15 px botón | Solo en lienzo cinematográfico |

### B.10 Iconografía

Librería **lucide-react**: trazo lineal, `stroke` 1.9–2.1, `round` cap y join, sin relleno, tamaños 14/17/18/20/22 px. Icono de marca: **casita con puerta** (`M3 11.5 12 4l9 7.5` + cuerpo), blanca sobre cuadrado redondeado con degradado. Los iconos de fila van en cuadro 36 px de 11 px de radio con fondo tintado del estado (`tone-bg-*`).

### B.11 Componentes

- **Botón primario:** píldora, degradado `155°`, texto blanco 700, sombra roja, `scale(.96)` al pulsar, hover sube 1 px. **Secundario:** vidrio `--surface-strong`, borde `--border`, texto `--text`, `shadow-sm`. **Peligro:** fondo `--critical-soft`, texto `--critical`. **Ghost:** transparente, texto muted. Altura 38 px (32 px "sm").
- **Píldora de estado:** 12 px/700, padding 4×12, fondo tinte 12%, borde tinte 24%, texto del color de estado, **punto de 6 px con halo de 3 px**.
- **Card:** vidrio `--surface`, borde 1 px blanco 65%, radio 26, `shadow-md`, título Manrope 800.
- **KPI:** etiqueta MAYÚSCULAS faint, cifra Manrope 800 grande (tono rojo o ámbar si urge), barra de 6 px con degradado rojo→ámbar.
- **Lista con icono:** fila `icono 36 / título + subtítulo / monto mono o pill`, separadores `--border-soft`, hover tintado.
- **Tabla:** cabecera 11 px MAYÚSCULAS faint, filas con esquinas redondeadas al hover, sin zebra, sin cajas pesadas.
- **Cita / evidencia (HITL):** borde izquierdo 3 px `--accent`, fondo `--accent-soft`, esquinas derechas redondeadas, etiqueta MAYÚSCULAS.
- **Pasos de progreso:** punto 22 px; hecho = verde relleno, activo = anillo carmesí, fallido = rojo relleno.
- **Toast:** vidrio sólido, radio 18, **borde izquierdo 4 px** del color de estado, icono + título Manrope 700 + mensaje muted.
- **Estado de carga:** spinner de anillo carmesí, o **skeleton** tinte rojo 10% con brillo que cruza.
- **Modal:** `surface-solid`, radio 26, `shadow-lg`, máx. 520 px, entra con resorte (translateY 14 px + scale .98).

---

## C. Modo claro y modo oscuro

**Claro ("crema cálida con vidrio").** Fondo crema rosado con tres brillos rosa/melocotón en esquinas; las tarjetas son casi blancas translúcidas y se despegan por la **sombra granate**, no por el borde (el borde blanco casi no se ve). El texto es marrón casi negro (no negro puro). El carmesí aparece solo en acciones, nav activo y cifras críticas.

**Oscuro ("marrón noche con brasas").** Fondo `#170F0E` (no es negro neutro: tiene calor), brillos vino y cobre, tarjetas marrones translúcidas con **borde blanco al 9%** que ahora sí define el contorno. Los acentos se aclaran (`#FF5A72`, `#FF97A6`, ámbar `#F0A860`) para mantener contraste. Las sombras pasan a negro.

**Conservar sí o sí (ambos modos):**
1. Degradado primario `#E23B52 → #9E1B30` con texto blanco.
2. Radios 26/18/12 y píldoras 999.
3. Vidrio + sombra suave + brillos de esquina difuminados.
4. Manrope en títulos, JetBrains Mono en cifras.
5. Pareja rojo + ámbar; verde/azul solo como estado.
6. Aire generoso (nada pegado a bordes).

**Seguro para proyectar:**
- Claro: texto `#241B1A` / `#6E615E`, carmesí `#C4223B` y granate `#9E1B30` sobre `#FFF8F6`, `info` `#2F5F9E`, ámbar `#B45309` (≥ 4.5:1).
- Oscuro: casi todo (texto `#F5E9E6`, muted `#C7B3AE`, `#FF5A72`, `#6FCB8A`, `#F0A860`, `#8FB6F0` con 6.3–9.5:1).
- Blanco sobre degradado primario **solo en texto grande o en negrita** (ver tabla).

**Contrastes calculados (WCAG):**

| Combinación | Ratio | Veredicto para proyección |
|---|---|---|
| Texto `#241B1A` sobre `#FFF8F6` | 16.05 | Excelente |
| Muted `#6E615E` sobre claro | 5.66 | OK |
| Granate `#9E1B30` sobre claro | 7.54 | Excelente |
| Carmesí `#C4223B` sobre claro | 5.50 | OK |
| Info `#2F5F9E` sobre claro | 6.15 | OK |
| Ámbar `#B45309` sobre claro | 4.78 | OK (solo ≥ 16 pt) |
| Verde `#4C8B5F` sobre claro | **3.87** | **Solo texto grande/negrita o icono** |
| Faint `#A69894` sobre claro | **2.65** | **Evitar para información** |
| Blanco sobre `#9E1B30` | 7.91 | Excelente |
| Blanco sobre `#C4223B` | 5.77 | OK |
| Blanco sobre `#E23B52` (inicio del degradado) | **4.22** | **Solo ≥ 18 pt o negrita** |
| Texto `#F5E9E6` sobre `#170F0E` | 15.91 | Excelente |
| Muted `#C7B3AE` sobre oscuro | 9.44 | Excelente |
| Faint `#8A7570` sobre oscuro | **4.37** | Solo pies/créditos, nunca datos |
| Rojo landing `#E82127` sobre `#0A0A0C` | **4.41** | Solo titulares grandes, no texto corrido |
| Gris landing `#86868B` sobre `#0A0A0C` | 5.46 | OK para secundarios |

**Combinaciones a evitar:**
- `--text-faint` como único portador de información (en claro falla; en oscuro es límite).
- Rojo sobre rojo: carmesí `#C4223B` o rojo landing sobre el degradado o sobre los brillos rojos.
- Verde `#4C8B5F` pequeño sobre claro; ámbar claro `#F0A860` sobre fondo claro (es la variante de oscuro).
- Texto sobre la **foto** de la landing sin el degradado de lectura (`rgba(10,10,12,.55)`).
- Mezclar acentos de claro y oscuro en la misma diapositiva (p. ej. `#FF5A72` sobre crema).
- Pill con fondo tinte al 12% proyectada en sala muy iluminada: el fondo "desaparece"; asegurar que el texto de la píldora lleve el color pleno del estado y ≥ 14 pt.

---

## D. Aplicación a las diapositivas

Reglas comunes: un solo mensaje por lámina; la tarjeta de vidrio es la unidad de composición; el rojo se reserva para **un** foco por lámina; las cifras en Manrope 800 (o JetBrains Mono si son montos o IDs).

| Tipo | Fondo | Estructura | Color | Títulos | Métricas | Capturas / mockups | Modo | Evitar |
|---|---|---|---|---|---|---|---|---|
| **Portada** | Cinematográfico: negro `#0A0A0C`→rojo `#E82127` con la foto existente `LandingBackground.png` (llaves + libreta) o bien `#170F0E` con brillos vino/cobre | Marca arriba-izq (insignia con degradado), título grande a la izquierda en 2 líneas, subtítulo, píldora blanca "Sustentación", datos del equipo abajo | Blanco + un acento rojo/degradado | Manrope/Inter 800, 54–60 pt, interlineado 1.0, tracking −2% | Ninguna | Opcional: tarjeta de vidrio con el dashboard inclinado ≤ 6° | **Oscuro** | Texto sobre la foto sin degradado de lectura; poner el rojo detrás del título |
| **Problema** | Claro `#FFF8F6` + brillo rosa arriba-izq | 3 tarjetas de vidrio (dolor 1/2/3) o 1 cifra héroe + 2 tarjetas | Granate para el dolor, ámbar para el riesgo | Título pregunta o afirmación, 40 pt | Cifra héroe 80–96 pt Manrope 800 en `#9E1B30` | Recortes sueltos de la realidad (arriendo, factura) en tarjetas con radio 26 | **Claro** | Más de 3 tarjetas; usar `faint` para el dato; verde |
| **AS-IS vs TO-BE** | Claro | Dos columnas: AS-IS en vidrio neutro con borde `--line`; TO-BE en vidrio con borde carmesí y degradado de cabecera; flecha píldora al centro | AS-IS gris-marrón muted + ámbar; TO-BE carmesí + verde | "Hoy" / "Con NotiHouse-Pal" como píldoras | Mismos 3 indicadores en ambos lados, TO-BE destacado | — | **Claro** | Que TO-BE y AS-IS pesen igual visualmente; tablas densas |
| **Arquitectura** | Mixto: oscuro `#170F0E` con brillos tenues, o claro con tarjetas | Diagrama horizontal en 3–4 capas: cada componente = tarjeta de vidrio radio 18 + icono lucide; flechas 2 pt carmesí | Nodos neutros; el flujo crítico (HITL) con degradado primario; ámbar para IA; azul solo "info" | Etiqueta MAYÚSCULAS faint + título 32 pt | Datos pequeños en JetBrains Mono (puertos, endpoints) | — | **Oscuro** (da profundidad) | Más de 12 nodos; líneas finas < 1.5 pt; texto < 14 pt |
| **Demo en vivo** | Claro (misma apariencia que la app en la sala) con marco mínimo | La demo ocupa el 80% de la lámina; título pequeño arriba; guion de 3 pasos como píldoras numeradas abajo | Pasos con punto de progreso (verde/anillo carmesí) | 28 pt, corto | KPI en la propia app | Pantalla completa real; **no** sustituir por mockup | **Claro** | Cubrir la demo con decoración; cambiar de tema a mitad de demo sin aviso; depender de internet para fuentes |
| **Video embebido** | Oscuro `#170F0E` | Video centrado en marco radio 26, `shadow-lg`, borde `rgba(255,255,255,.09)`; título corto arriba y una línea de contexto abajo | Neutro; un halo rojo muy suave detrás | 32 pt | Duración en JetBrains Mono (`0:45`) | El video es el protagonista | **Oscuro** | Video sin póster; marco rojo saturado; autoplay sin respaldo (tener el archivo local) |
| **Evidencia de pruebas** | Claro | Fila de 3–4 KPI (cifra + etiqueta + barra rojo→ámbar) y debajo una tabla limpia o captura de log en tarjeta oscura | Verde para pasadas, granate para falladas, ámbar para pendientes | 40 pt | Cifra 64–80 pt; "4/4" o "98%" con etiqueta MAYÚSCULAS | Logs en tarjeta `#170F0E` con JetBrains Mono ≥ 14 pt | **Claro** (+ tarjeta oscura para log) | Logs ilegibles; verde pequeño sobre crema; capturas de 4 K sin recortar |
| **Gobierno y seguridad** | Mixto/oscuro | Pilar central "HITL: aprobar → aplicar → cerrar" como pasos conectados, + tarjetas de controles (kill switch, datos ficticios, solo lectura) | Carmesí = control humano; verde = permitido; ámbar = límite | 40 pt | Contadores pequeños (JetBrains Mono) | Cita de revisión HITL con borde izq. 3 px carmesí | **Oscuro** | Iconos de escudo/candado genéricos; exceso de rojo que parezca alarma |
| **Caso de negocio** | Claro con brillo ámbar abajo-der | Cifra héroe + 3 tarjetas de beneficio + 1 línea de supuestos | Ámbar/carmesí para ahorro, verde para retorno | 40 pt | Héroe 96 pt Manrope 800; sufijo en 28 pt | Gráfico simple (ver E.6) | **Claro** | Cifras sin fuente ni supuesto; gráficos 3D |
| **Cierre final** | Cinematográfico, eco de la portada | Frase final en 2 líneas, píldora blanca con la acción ("Gracias / Preguntas"), QR o enlace en tarjeta de vidrio | Blanco + degradado primario | 54–60 pt | — | Una captura del producto pequeña | **Oscuro** | Cerrar en una lámina de "Gracias" vacía; ocultar contacto |

### Propuesta de 14 diapositivas (con su tipo)

1. Portada · 2. Problema · 3. Usuarios y contexto (claro) · 4. AS-IS vs TO-BE · 5. Solución en una vista (resumen de producto) · 6. Arquitectura · 7. Flujo HITL / IA (arquitectura-variante) · 8. Demo en vivo · 9. Video (respaldo) · 10. Evidencia de pruebas · 11. Gobierno y seguridad · 12. Caso de negocio · 13. Alcance, límites y siguientes pasos · 14. Cierre.

---

## E. Guía maestra para PowerPoint / Canva

**E.1 Lienzo.** 16:9, **13.333 × 7.5 in** (PowerPoint) o 1920 × 1080 px (Canva). Todo lo siguiente está dado para ese tamaño.

**E.2 Márgenes seguros.** 0.6 in laterales, 0.5 in arriba y abajo (≈ 4.5% / 7%). Nada importante en el último 0.35 in (proyectores recortan). Pie en la franja 7.0–7.3 in.

**E.3 Rejilla.** 12 columnas, gutter 0.25 in (≈ 14–18 px de la app). Distancia entre tarjetas: 0.25 in; padding interno de tarjeta: 0.3 in.

**E.4 Tipografías.**
- Títulos: **Manrope ExtraBold (800)**. Texto: **Public Sans** Regular/SemiBold. Cifras y código: **JetBrains Mono** Medium. Cinematográficas (portada/cierre): Manrope 800 (Inter 800 es aceptable, es la de la landing).
- Las tres son Google Fonts: **instalarlas en el equipo de la sala** o exportar a PDF y proyectar el PDF; en PowerPoint incrustar fuentes (Archivo → Opciones → Guardar). Canva incluye Manrope y JetBrains Mono; verificar Public Sans, si no está usar "Subir fuente".
- Fallback si falla: Segoe UI / Calibri (texto) y Consolas (cifras).

**E.5 Escala tipográfica (pt, mínimos para sala).**

| Nivel | Tamaño | Peso | Color claro / oscuro |
|---|---|---|---|
| Titular de portada | 54–60 | 800, tracking −2% | `#FFFFFF` |
| Título de lámina | 36–40 | 800 | `#241B1A` / `#F5E9E6` |
| Subtítulo | 22–24 | 600 | `#6E615E` / `#C7B3AE` |
| Cuerpo | **≥ 20** | 400/500 | igual que título |
| Etiqueta MAYÚSCULAS | 14–16, tracking +6% | 700 | `#6E615E` (no faint) / `#C7B3AE` |
| Cifra héroe | 72–96 | 800 | `#9E1B30` o degradado / `#FF97A6` |
| Pie / fuentes | **≥ 12** | 400 | `#6E615E` / `#C7B3AE` |

Máximo 6 líneas de cuerpo por lámina; títulos ≤ 2 líneas.

**E.6 Highlights, citas, gráficos, diagramas.**
- **Highlight:** píldora con fondo tinte de estado al 12–16% y texto del color pleno (misma receta del badge), o barra lateral 3 pt carmesí con fondo `rgba(196,34,59,.10)` (cita HITL). No usar subrayado amarillo ni fosforescente.
- **Cita / fuente:** cita con borde izquierdo carmesí y etiqueta MAYÚSCULAS ("EVIDENCIA", "FUENTE"); fuente en el pie, 12 pt, muted, formato `Fuente: …, fecha`.
- **Gráficos:** barras redondeadas (radio superior 6), una sola serie en degradado rojo→ámbar o carmesí liso; comparaciones: carmesí vs gris-marrón `#A69894`; semáforo solo si el significado es estado (verde/ámbar/granate). Sin 3D, sin sombra en las barras, sin rejilla densa; líneas guía `rgba(158,27,48,.10)`; etiquetas directas en vez de leyenda; valores en JetBrains Mono.
- **Diagramas:** nodos = tarjeta radio 18, borde 1 pt `--line`, icono lucide 2 pt; conectores 2 pt carmesí o muted con punta redondeada; el flujo principal en degradado primario y el resto neutro. Máx. 4 columnas × 3 filas.

**E.7 Receta de vidrio, sombra y brillos (PowerPoint/Canva no tienen `backdrop-filter`).**
- **Brillos de esquina:** 3 círculos sin borde con relleno `#FF6B72`, `#FFB37B`, `#FFD9D3` (claro) o `#B23048`, `#8A5A2A`, `#4A2420` (oscuro); tamaños ≈ 4.8 in, 4.1 in, 2.9 in; **desenfoque suave** (PowerPoint: Efecto "Suave" 80–100 pt o PNG pre-desenfocado; Canva: Efectos → Desenfocar 80) y transparencia 45% (opacidad 55%). Posiciones: A sobre la esquina sup-izq (corte −1 in), B esquina inf-der, C centro-derecha. Usarlos en el **patrón** de diapositiva.
- **Tarjeta de vidrio claro:** relleno `#FFFFFF` transparencia 25–35% (opacidad 65–75%), contorno `#FFFFFF` 1 pt al 65%, radio ≈ 0.28 in, sombra exterior: color `#9E1B30`, transparencia 86%, desenfoque 28 pt, distancia 10 pt, ángulo 90°.
- **Tarjeta de vidrio oscuro:** relleno `#281B19` opacidad 70–82%, contorno `#FFFFFF` al 9% 1 pt, sombra `#000000` transparencia 55%, desenfoque 28 pt.
- **Equivalente sólido (si hay riesgo de render):** claro `#FFFDFC`, oscuro `#2A1C1A`.
- **Botón/píldora primaria:** radio total, relleno degradado lineal 155°: parada 0% `#E23B52`, 100% `#9E1B30`, texto blanco 700, sombra `#9E1B30` al 70% transparencia, desenfoque 16 pt, distancia 8 pt.

**E.8 Pie de página.** Izquierda: insignia pequeña (casita blanca sobre cuadrado 0.3 in con degradado) + "NotiHouse-Pal"; centro: fuente de la lámina; derecha: número `NN / 14` en JetBrains Mono 12 pt. Altura 0.3 in, sin línea divisoria pesada (si hay, 0.5 pt `--line`).

**E.9 Transiciones y animación (mínimas).** Transición única en todo el deck: **Desvanecer** 0.4 s (o "Empujar suave" si se desea resorte, no más). Animación de entrada solo en 1) cifra héroe (aparecer con zoom 0.96→1, 0.4 s) y 2) pasos del flujo HITL (uno a uno, desvanecer). Sin rebotes, giros ni 3D. Respeta el criterio de la app: `prefers-reduced-motion` → mover poco.

---

## F. Entregables

### F.1 Resumen ejecutivo

NotiHouse-Pal tiene una identidad ya resuelta: **carmesí `#C4223B` con degradado `#E23B52 → #9E1B30`, acento ámbar `#B45309`, fondos crema `#FFF8F6` / marrón noche `#170F0E`, tarjetas de vidrio con radio 26, sombras teñidas de granate y brillos de esquina difuminados**, con Manrope/Public Sans/JetBrains Mono. La Landing añade un lienzo cinematográfico negro-rojo con una foto de llaves y libreta. La presentación debe usar el lienzo cinematográfico en **portada y cierre**, y el lienzo de producto (vidrio, claro u oscuro) en el contenido. Los puntos de cuidado son de **contraste**: `faint` en claro (2.65), verde pequeño sobre crema (3.87) y blanco sobre el extremo claro del degradado (4.22) no sirven para texto pequeño proyectado.

### F.2 Tabla de tokens (copiar a la plantilla)

| Token | Claro | Oscuro |
|---|---|---|
| Fondo / fondo 2 | `#FFF8F6` / `#FDEEE9` | `#170F0E` / `#1E1412` |
| Brillos A / B / C | `#FF6B72` / `#FFB37B` / `#FFD9D3` | `#B23048` / `#8A5A2A` / `#4A2420` |
| Texto / muted / faint | `#241B1A` / `#6E615E` / `#A69894` | `#F5E9E6` / `#C7B3AE` / `#8A7570` |
| Acento / vivo / ink | `#C4223B` / `#E23B52` / `#9E1B30` | `#FF5A72` / `#FF7A8C` / `#FF97A6` |
| Secundario ámbar | `#B45309` | `#F0A860` |
| Éxito / Warn / Error / Info | `#4C8B5F` / `#B45309` / `#9E1B30` / `#2F5F9E` | `#6FCB8A` / `#F0A860` / `#FF7A8C` / `#8FB6F0` |
| Degradado primario | 155°, `#E23B52 → #9E1B30` | igual |
| Vidrio | blanco 50% / 80% / 94% | `#281B19` 55% / `#30211E` 82% / `#201513` 96% |
| Borde de vidrio | blanco 65% | blanco 9% |
| Radios | 26 / 18 / 12 / 999 | igual |
| Sombras | 0 4 18 / 0 12 40 / 0 28 70 en `rgba(158,27,48,.10/.14/.20)` | mismas en `rgba(0,0,0,.35/.45/.55)` |
| Blur | 22 (card), 26 (sidebar/modal), 80 (brillos) | igual |
| Fuentes | Manrope 800 / Public Sans / JetBrains Mono | igual |
| Cinematográfico | `#0A0A0C`, `#E82127`, `#B5121B`, blanco, `#86868B` | — |

### F.3 Guía para diapositivas

Ver secciones D y E (tabla por tipo, escala tipográfica, recetas de vidrio, sombra, brillo, gráficos y diagramas).

### F.4 Hacer / No hacer

**Hacer**
- Usar el degradado primario en **un** elemento por lámina (botón, cifra héroe o insignia).
- Poner tarjetas de vidrio sobre brillos de esquina difuminados.
- Cifras y montos en JetBrains Mono / Manrope 800, con etiqueta MAYÚSCULAS arriba.
- Mantener radios generosos (26/18/12) y sombras suaves teñidas.
- Texto de cuerpo ≥ 20 pt, pies ≥ 12 pt, ≥ 4.5:1 de contraste.
- Usar capturas reales del producto, en tarjeta con radio y sombra, recortadas al detalle relevante.
- Declarar la fuente de cada cifra y los supuestos (se trata de datos ficticios del MVP).
- Probar la presentación en proyector y tener un PDF de respaldo.

**No hacer**
- No introducir azul, morado, verde neón ni cian como colores de marca.
- No usar `faint` para información, ni verde pequeño sobre crema, ni blanco chico sobre `#E23B52`.
- No apilar sombras duras grises, bordes gruesos ni cajas con esquina recta.
- No saturar: más de un foco rojo por lámina, más de 3 tarjetas "héroe", más de 6 líneas de texto.
- No usar plantillas, clip-art, emojis ni iconos de stock con estilos mezclados (usar lucide, trazo ~2).
- No cambiar de modo claro/oscuro dentro de una misma lámina (excepto una tarjeta de log oscura en lámina clara).
- No animar más allá de fundidos; no GIF decorativos.
- No prometer en la lámina lo que el MVP no hace (ver `docs/qa/CIERRE_MVP_2026-11-10.md`).

### F.5 Tres direcciones visuales

**Opción 1 — Más clara ("Crema y vidrio")**
Todas las láminas con el lienzo claro: `#FFF8F6`, brillos rosa/melocotón, tarjetas de vidrio blanco, títulos `#241B1A`, un único acento carmesí. Portada y cierre con degradado granate suave en lugar de foto.
- Pros: máxima legibilidad en salas iluminadas; fiel a la app en uso normal; las capturas encajan solas; fácil de imprimir.
- Contras: menos impacto cinematográfico; el vidrio pierde contraste si el proyector lava los blancos; riesgo de verse "plano".

**Opción 2 — Más oscura ("Marrón noche con brasas")**
Todo en `#170F0E`, brillos vino y cobre, tarjetas marrones con borde de 9% de blanco, acentos `#FF5A72`/`#F0A860`. Portada y cierre con la foto de la landing.
- Pros: muy premium y moderno; contraste altísimo en casi todo; cifras que "brillan"; coherente con la landing.
- Contras: en salas luminosas o con proyector de bajo contraste los marrones se funden; las capturas de claro desentonan (hay que usar capturas en tema oscuro); fatiga en 14 láminas; tablas densas pierden aire.

**Opción 3 — Híbrida claro/oscuro ("Apertura cinematográfica, contenido claro, evidencia oscura")**
- **Oscuro cinematográfico:** portada (1), cierre (14), separadores y video (9).
- **Claro vidrio:** problema, AS-IS/TO-BE, demo, evidencia, caso de negocio (2, 4, 8, 10, 12, 13).
- **Oscuro de producto:** arquitectura, flujo HITL, gobierno (6, 7, 11).
Mantiene tokens iguales en ambos modos y una regla de transición: siempre pasar de oscuro a claro con una lámina de transición (título sobre degradado).
- Pros: ritmo narrativo, premium y legible; cada tipo de lámina usa el modo que mejor lo sirve; es cómo vive el producto (landing oscura → app).
- Contras: exige disciplina de patrón maestro (2–3 diseños) y más trabajo de pruebas de contraste; riesgo de "saltos" si se abusa de alternar.

### F.6 Recomendación final: **Opción 3, Híbrida**

**Justificación.**
1. **Es lo que ya hace el producto:** el usuario llega por una puerta negro-rojo cinematográfica (landing/login) y trabaja en un espacio cálido de vidrio. Reproducir esa secuencia hace la presentación "una extensión natural del frontend".
2. **Protege la legibilidad:** el contenido denso (cifras, tablas, comparaciones, pruebas) va en claro con textos de 16.05:1; el modo oscuro se reserva para láminas con poco texto o donde el contraste es altísimo (≥ 6:1 en todo).
3. **Pone el impacto donde importa:** el comité recuerda la apertura y el cierre; ahí se justifica la foto y el degradado.
4. **Reduce el riesgo del proyector:** si la sala está muy iluminada, el 70% del deck ya está en claro, y las láminas oscuras tienen texto grande.
5. **Demo coherente:** la app se proyecta en claro, igual que las láminas de demo y evidencia, sin choque de modos.

**Reglas de implementación del híbrido:**
- Patrón maestro A (oscuro cinematográfico), B (claro vidrio) y C (oscuro producto).
- Mismos radios, sombras, tipografías y degradado en los tres.
- Un solo acento rojo por lámina; ámbar para el segundo énfasis.
- Escalar capturas siempre en el modo del patrón donde se insertan (claro en B, oscuro en C).
- Exportar PDF de respaldo y tener el video local.

---

### Anexo — Limitaciones declaradas

- No se abrieron las pantallas autenticadas con datos reales (requieren login con las credenciales de demostración, que no se tocaron); el aspecto de dashboard/bandeja/HITL/obligaciones/documentos se deduce del código y de la maqueta con los CSS reales. **Antes de insertar capturas, tomar capturas reales** en claro y oscuro (la app permite forzar el tema con `data-theme`).
- Los colores efectivos de los brillos (≈) y las equivalencias en pt/in son estimaciones.
- La tabla de contraste usa fondos sólidos; el vidrio translúcido sobre brillos puede bajar el ratio real 0.3–0.8 puntos en el borde del brillo.
- Los cambios sin commit en el frontend (refactor UX del 2026-11-11) se tomaron tal como están en el árbol de trabajo.
