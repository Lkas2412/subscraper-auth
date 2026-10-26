# SubScraper Auth (extensión)

Extensión WebExtension (MV3) de uso personal: al entrar a OnlyFans con la
sesión iniciada, cosecha el auth (mismo formato que guardan las apps de
escritorio) y lo envía automáticamente al destino configurado. Postea una
vez por sesión dentro de la misma sesión del navegador; si la sesión
cambia (login nuevo), envía de nuevo.

El popup muestra el estado (solo presencias, nunca valores) y permite
forzar un envío manual.

## Instalación

- **Orion (iOS/macOS)**: descargar el zip de la release → en Orion,
  Settings → Extensions → activar extensiones de terceros → Extensions →
  **+** → elegir el archivo (sin descomprimir; si lo rechaza, renombrar
  a `.xpi`).
- **Chrome/Edge (escritorio)**: descomprimir el zip → `chrome://extensions`
  (o `edge://extensions`) → modo desarrollador → «Cargar sin empaquetar» →
  elegir la carpeta.
- **Firefox (escritorio)**: `about:debugging#/runtime/this-firefox` →
  «Cargar complemento temporal» → elegir el zip.

El código fuente de este repo trae el destino como placeholder
(`__WEBHOOK_URL__` en `background.js`); el zip de la release ya lo trae
configurado.
