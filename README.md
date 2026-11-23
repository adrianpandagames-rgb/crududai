# CRUD UDAI

Aplicación web interna para administrar objetivos, líneas telefónicas, contactos, IMEI, georreferenciación y otras herramientas de consulta. Está construida con Node.js, Express, EJS y MySQL. Incluye autenticación, administración de usuarios, bitácora de actividad y una API para el bot de Telegram.

## Requisitos

- Node.js 22.x y npm.
- MySQL 8.x con una base de datos creada y permisos para las migraciones.
- Una copia local de las variables de entorno, basada en `.env.example`.

Para la opción de contenedores se requiere Docker Desktop con Docker Compose; consulta [DOCKER.md](DOCKER.md).

## Inicio local

1. Instala dependencias:

   ```sh
   npm ci
   ```

   El proyecto incluye `xlsx-0.20.3.tgz`, requerido por `npm ci`.

2. Crea la base de datos MySQL y copia `.env.example` a `.env`. Completa al menos `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` y `DB_NAME`.

3. Si ya tienes una base compatible con el esquema de la aplicación, crea un respaldo y aplica las migraciones pendientes:

   ```sh
   npm run migrate
   ```

   `npm run migrate` aplica las migraciones versionadas de `migrations/`; no crea por sí solo una base nueva desde cero. Las migraciones alteran el esquema y MySQL no puede revertir automáticamente cada cambio DDL. Para una instalación nueva, prepara primero el esquema base requerido por la aplicación.

4. Inicia el servidor:

   ```sh
   npm run dev
   ```

   Para ejecutarlo sin nodemon, usa `npm start`. La configuración local predeterminada escucha HTTP en el puerto `3600` y HTTPS en `3443`; configura `HOST`, `PORT` y `HTTPS_PORT` según tu entorno. Si no proporcionas certificados TLS, la aplicación crea certificados locales autofirmados.

## Configuración

La lista de variables y sus comentarios está en [`.env.example`](.env.example). No guardes credenciales reales en Git.

Entre las variables opcionales están:

- `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASSWORD`, `SMTP_FROM`: envío de avisos por correo.
- `PUBLIC_BASE_URL` y opciones `WEBAUTHN_*`: dominio HTTPS y configuración de llaves de acceso para la verificación en dos pasos.
- `IMEI_API_KEY`, `IMEI_SERVICE_ID` y `PHONE_VALIDATION_ACCESS_KEY`: servicios externos de consulta.
- `GOOGLE_GEOCODING_API_KEY` y `CARTO_API_KEY`: georreferenciación y mapa de medidores.
- Variables `TELEGRAM_*`: integración del bot. Consulta la [guía del bot](telegram_bot/README.md).

En producción, configura HTTPS detrás del proxy o alojamiento correspondiente y define `TRUST_PROXY` solo para proxies confiables. Las sesiones de la aplicación se guardan en memoria y se invalidan al reiniciar el proceso.

## Migraciones

El comando `npm run migrate` aplica las migraciones versionadas. Puedes consultar su estado o revisar pendientes sin aplicarlas:

```sh
npm run migrate -- --estado
npm run migrate -- --revisar
```

Haz un respaldo antes de cambiar el esquema. Hay también comandos independientes para cambios específicos; sus nombres están declarados en `package.json` y sus implementaciones en `scripts/`. Por ejemplo:

```sh
npm run migrate:lineas-delito
npm run migrate:telegram-users
npm run migrate:audit-logs
```

Ejecuta una migración con la configuración de base de datos del entorno antes de habilitar la función que depende de ella. Para el despliegue de Docker y la copia de datos actuales, sigue los pasos de [DOCKER.md](DOCKER.md).

## Funciones con datos o servicios externos

### Georreferenciación y entrecalles

La georreferenciación puede usar Google Geocoding y una red vial local de OpenStreetMap. Configura `GOOGLE_GEOCODING_API_KEY`. Para importar o revisar la red vial:

```sh
npm run import:red-vial
node scripts/check-red-vial.js
```

El importador espera un archivo PBF; por defecto usa `data/osm/mexico-latest.osm.pbf`. Los archivos grandes de mapas no se incluyen en Git. Los resultados y las entrecalles pueden requerir revisión, especialmente fuera de la cobertura de la red vial. Datos viales: [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

### Delito en líneas

El campo de delito es opcional y pertenece a cada registro individual. Para actualizar un despliegue que aún no tiene la columna, ejecuta `npm run migrate:lineas-delito` con sus credenciales de base de datos.

### Bot de Telegram

El bot está implementado en Python y se configura aparte del servidor web. Consulta [telegram_bot/README.md](telegram_bot/README.md) para instalarlo, configurarlo y administrar el proceso.

## Docker

La guía [DOCKER.md](DOCKER.md) describe cómo preparar una copia de la base MySQL existente e iniciar la aplicación y MySQL en contenedores. La preparación requiere `mysqldump`. Los volúmenes de Docker conservan los datos entre reinicios; no uses `docker compose down -v` si quieres conservarlos.

## Scripts disponibles

Los principales scripts definidos en `package.json` son:

| Comando | Uso |
| --- | --- |
| `npm run dev` | Servidor local con nodemon |
| `npm start` | Servidor Node.js |
| `npm run build` | Comprobación sintáctica de `app.js` |
| `npm test` | Pruebas con el ejecutor integrado de Node.js |
| `npm run migrate` | Migrador principal |
| `npm run import:red-vial` | Importación de la red vial desde PBF |

También hay comandos `migrate:*` para cambios individuales de esquema. Consulta `package.json` para la lista completa.

## Estructura

- `app.js`: configuración y arranque de Express.
- `src/`: rutas, servicios, autenticación y acceso a datos.
- `views/` y `public/`: vistas EJS y recursos del navegador.
- `BD/`, `migrations/` y `scripts/`: SQL, migraciones y tareas de mantenimiento.
- `telegram_bot/`: cliente de Telegram en Python.
- `test/`: pruebas automatizadas.
- `docs/` y `manuales/`: documentación complementaria.

## Despliegue y otros documentos

- [DOCKER.md](DOCKER.md): ejecución local en Docker.
- [telegram_bot/README.md](telegram_bot/README.md): instalación y comandos del bot.
- [GEOREFERENCIACION.md](GEOREFERENCIACION.md): detalles de georreferenciación.
- [SECURITY-FIXES.md](SECURITY-FIXES.md): registro de correcciones de seguridad.
