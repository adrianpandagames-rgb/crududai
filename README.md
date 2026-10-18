# CRUD UDAI

Para publicar desde GitHub en GoDaddy, consulta [GODADDY.md](GODADDY.md).

## Entrecalles en Georreferenciación

Al importar un CSV o XLSX con latitud y longitud, se obtiene la dirección con
Google Geocoding y se calculan las entrecalles con la red vial de OpenStreetMap.
Configura `GOOGLE_GEOCODING_API_KEY`. Las entrecalles se calculan desde MySQL:
el módulo ya no consulta Overpass ni necesita `OVERPASS_API_URL`.

Para instalar o actualizar la red vial:

1. Descarga [mexico-latest.osm.pbf de Geofabrik](https://download.geofabrik.de/north-america/mexico.html)
   y guárdalo en `data/osm/mexico-latest.osm.pbf`.
2. Ejecuta `npm run import:red-vial` (o añade la ruta de otro archivo PBF).
3. Ejecuta `node scripts/check-red-vial.js` para comprobar la red importada.

Se importan las vías transitables del rectángulo 26–33° N, 115–108° O,
que cubre Sonora y una zona limítrofe; no es un recorte administrativo exacto.
El lector trabaja en flujo y conserva nodos de esa región en memoria (hasta
4 GB de heap). Una actualización solo se activa cuando finaliza correctamente;
las versiones anteriores se conservan para no interrumpir archivos en proceso.
Actualiza el extracto periódicamente. Los archivos grandes están excluidos de Git.

Antes de consultar servicios externos se busca la coordenada en MySQL, usando
la precisión almacenada de nueve decimales. Si existe, se reutilizan la dirección,
el lugar y las entrecalles encontradas. Si las entrecalles están pendientes o el
servicio falló anteriormente, se calculan con la red local, sin consultar Google
ni Overpass. Para direcciones guardadas sin nombre de calle se identifica la vía
más próxima; si hay dos candidatas a distancias similares se solicita revisión.
Las coordenadas nuevas se consultan en Google y guardan; las repetidas
dentro de un archivo reutilizan el resultado en memoria.

El campo `ubicacion` se guarda como `Calle principal, entre Calle X y Calle Y,
Colonia, C.P. 83000` y `lugar` como `Ciudad, Estado`. El número exterior no se
incluye. Los componentes ausentes se omiten; las entrecalles se incluyen solo
cuando están disponibles ambas. Los componentes de Google se conservan en JSON
para reconstruir el formato sin nuevas consultas. Ejecuta
`node scripts/format-georeferenciacion.js` para convertir registros anteriores
con componentes suficientes; los casos ambiguos conservan su dirección original.

Las exportaciones incluyen `entre_calle_1`, `entre_calle_2`, `estado_entrecalles`
y `fuente_entrecalles`. Los nombres y el estado también se guardan en la tabla
de ubicaciones. Las columnas de MySQL se agregan al abrir el módulo; la cuenta
de base de datos necesita permiso ALTER sobre `georeferenciacion_ubicaciones`.
Los archivos ya procesados no se recalculan: vuelve a importarlos para obtener
las entrecalles.

`ENCONTRADAS` indica dos cruces sugeridos, `REQUIERE_REVISION` indica datos
insuficientes o ambiguos, `RED_LOCAL_NO_CARGADA` indica que falta importar el mapa,
`SERVICIO_NO_DISPONIBLE` puede aparecer en resultados anteriores del proveedor
y `NO_APLICA` indica que no se obtuvo una dirección válida. Se exige coincidencia
del nombre de calle, cercanía de hasta 60 metros y conexiones viales reales;
se recorre hasta 800 metros en cada dirección. Esquinas, ramificaciones y cruces
sin nombre requieren revisión. La ausencia de entrecalles no elimina la dirección.
Cuando un extremo conecta con varias calles, se conservan sus nombres separados
por `/` y el estado queda en `REQUIERE_REVISION`. Si solo se conoce un extremo,
se conserva ese nombre en su columna; no se asigna una segunda calle.

Las consultas viales reutilizan zonas cercanas por archivo y conservan los
identificadores originales de nodos para distinguir puentes de cruces conectados.
Fuera de la cobertura o sin datos suficientes se solicita revisión.
Verifica los resultados antes de utilizarlos.
Datos viales: [© OpenStreetMap contributors](https://www.openstreetmap.org/copyright).

## Docker

Para ejecutar la aplicación y MySQL en contenedores con una copia de tus datos
actuales, sigue [la guía de Docker](DOCKER.md).

![Node.js](https://img.shields.io/badge/Node.js-18%2B-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-4.x-000000?logo=express&logoColor=white)
![MySQL](https://img.shields.io/badge/MySQL-8.x-4479A1?logo=mysql&logoColor=white)
![License](https://img.shields.io/badge/License-ISC-blue)

Aplicación web desarrollada con Node.js, Express y MySQL para gestionar información relacionada con estudiantes, objetivos, contactos e IMEIs.

## Descripción general

Este proyecto ofrece una interfaz web para:

- gestionar estudiantes y sus datos básicos;
- registrar objetivos y contactos asociados;
- almacenar IMEIs y validar posibles duplicados o coincidencias;
- consultar metadatos de IMEI mediante una API externa;
- importar archivos CSV compatibles con Excel en Ruta para numerar antenas y completar sus ubicaciones;
- autenticar usuarios con sesiones y opción de recordar sesión.

La aplicación usa EJS como motor de vistas y sirve contenido estático desde la carpeta public.

## Tecnologías utilizadas

- Node.js
- Express
- EJS
- MySQL / mysql2
- bcrypt
- dotenv
- multer
- CORS
- Node test runner para pruebas

## Estructura del proyecto

- app.js: punto de entrada principal del servidor.
- src/: lógica de base de datos, enrutamiento, sesiones, servicios de IMEI y controladores.
- views/: plantillas EJS para las páginas y parciales.
- public/: archivos estáticos como CSS, JS e imágenes.
- BD/: scripts SQL para crear y cargar tablas base.
- test/: pruebas automatizadas del proyecto.

## Requisitos

Antes de ejecutar la aplicación asegúrate de tener instalado:

- Node.js 18 o superior
- MySQL
- npm

## Instalación

1. Clona el repositorio:

   ```bash
   git clone <url-del-repositorio>
   cd crududai
   ```

2. Instala las dependencias:

   ```bash
   npm install
   ```

3. Crea una base de datos en MySQL y carga los scripts SQL de la carpeta BD.

   Ejemplo:

   ```bash
   mysql -u <usuario> -p
   CREATE DATABASE crudnodejs;
   use crudnodejs;
   source BD/imei.sql;
   ```

4. Ejecuta las migraciones de usuarios, incluida la que permite forzar el cambio de una contraseña temporal:

   ```bash
   npm run migrate:user-status
   npm run migrate:initial-admin
   npm run migrate:must-change-password
   ```

## Configuración por entorno

Este proyecto usa variables de entorno para separar desarrollo y producción. Crea dos archivos en la raíz del proyecto:

- `.env.development`
- `.env.production`

### Ejemplo para desarrollo

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=crudnodejs_dev

HOST=0.0.0.0
PORT=3600
HTTPS_PORT=3443
NODE_ENV=development

IMEI_API_KEY=tu_api_key
IMEI_SERVICE_ID=0
```

### Ejemplo para producción

```env
DB_HOST=servidor-produccion
DB_USER=usuario_app
DB_PASSWORD=tu_password_segura
DB_NAME=crudnodejs_prod

HOST=0.0.0.0
PORT=80
HTTPS_PORT=443
NODE_ENV=production

IMEI_API_KEY=tu_api_key
IMEI_SERVICE_ID=0
```

> Nunca guardes secretos reales en el repositorio. Agrega `.env.development` y `.env.production` al `.gitignore` o usa un archivo local no versionado.

### Truecaller para sitios móviles

La pestaña **OSINT** integra la verificación web de Truecaller en Android. Solo muestra el perfil que la persona usuaria acepta compartir; no sirve para buscar perfiles de terceros por número. Los datos del perfil se mantienen temporalmente en memoria y no se almacenan en la base de datos.

Registra una aplicación de tipo **Web** en el [portal de desarrolladores de Truecaller](https://developer.truecaller.com/login), usando el dominio `app.aiuecs.tech` y este callback HTTPS exacto:

```text
https://app.aiuecs.tech/api/truecaller/callback
```

Configura `TRUECALLER_APP_KEY`, `TRUECALLER_APP_NAME`, `TRUECALLER_PRIVACY_URL` y `TRUECALLER_TERMS_URL` en el entorno de producción. Usa `https://app.aiuecs.tech/terminos` como URL de términos. `TRUECALLER_PRIVACY_URL` debe apuntar a una política de privacidad HTTPS publicada por tu organización. Reinicia la app después de guardar la configuración. La documentación de [generación de App Key](https://docs.truecaller.com/truecaller-sdk/mobile-websites/generating-app-key) describe el callback y los requisitos HTTPS.

### Scripts recomendados

En `package.json` puedes dejar esto:

```json
"scripts": {
  "dev": "cross-env NODE_ENV=development nodemon app.js",
  "start": "cross-env NODE_ENV=production node app.js"
}
```

Entonces ejecutas:

```bash
npm run dev
```

O en producción:

```bash
npm start
```

La aplicación quedará disponible en:

- HTTP: http://localhost:3600
- HTTPS: https://localhost:3443

El puerto HTTP redirige automáticamente a HTTPS.

### Nota sobre `cross-env`

En Windows, `NODE_ENV=development` puede no funcionar como se espera en consola. Por eso se recomienda `cross-env` para que el valor se establezca correctamente en todos los sistemas operativos.

## Pruebas

Para ejecutar la suite de pruebas:

```bash
npm test
```

## Notas importantes

- La app genera certificados HTTPS locales automáticamente si no existen en la carpeta certs.
- Algunas rutas están protegidas por autenticación basada en cookies.
- Las contraseñas generadas al crear o restablecer un usuario son temporales; el usuario debe reemplazarlas en el modal mostrado al iniciar sesión.
- El proyecto incluye lógica para revisar metadatos de IMEI de forma programada.

## Flujo típico de uso

1. Iniciar sesión desde la pantalla inicial.
2. Navegar a la sección de objetivos o IMEIs.
3. Registrar contactos, objetivos y dispositivos.
4. Revisar coincidencias y alertas de posible duplicidad.

## Capturas de pantalla

Pronto se agregarán capturas de la interfaz para mostrar el flujo principal de la aplicación.

## Ejemplos de uso

- Crear un objetivo nuevo desde la vista de estudiantes.
- Registrar un IMEI asociado a un objetivo existente.
- Consultar coincidencias para detectar posibles duplicados.
- Revisar la información de marca y modelo recuperada desde la API de IMEI.

Si deseas, también puedo preparar una versión del README en inglés o agregar ejemplos más detallados de uso.

## Iniciar el servidor al iniciar sesión en Windows

Windows no inicia un archivo `.ps1` directamente desde la lista de aplicaciones
de inicio. Crea un acceso directo y, en sus propiedades, configura:

```text
Destino: %SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "C:\ruta\completa\crududai\run.server.ps1"
Iniciar en: C:\ruta\completa\crududai
```

Escribe únicamente el valor de cada línea en el campo con ese nombre; no incluyas
las etiquetas `Destino:` ni `Iniciar en:`. Reemplaza las rutas por la ubicación
del proyecto y agrega el acceso directo a la carpeta de inicio de Windows
(abre `shell:startup`). El script ejecuta `npm run dev`;
los registros quedan en `%LOCALAPPDATA%\CRUDUDAI\logs\server.stdout.log` y
`server.stderr.log`.

## Crear un ejecutable Windows y ejecutarlo como servicio (`correlatador`)

Si quieres un "ejecutable" que pueda iniciarse y ejecutarse en segundo plano con un nombre fácil de identificar, sigue estos pasos.

1) Generar el ejecutable (requiere `pkg`):

```powershell
npm install
npm run package:win
```

El ejecutable resultante quedará en `dist\correlatador.exe`.

2) Instalar como servicio de Windows (ejecutar PowerShell como Administrador):

```powershell
.\tools\install-service.ps1 -ExePath "C:\ruta\completa\a\tu\repo\dist\correlatador.exe"
```

Si omites `-ExePath`, el script usa `dist\correlatador.exe` por defecto.

3) Detener y desinstalar el servicio (Administrador):

```powershell
.\tools\uninstall-service.ps1
```

Notas:

- El servicio creado se llamará `correlatador` y puede gestionarse desde `services.msc` o con `Start-Service`/`Stop-Service`.
- Asegúrate de construir el ejecutable compatible con tu arquitectura (el script usa `node18-win-x64`).
- Si prefieres no instalar como servicio, puedes ejecutar el exe directamente; para iniciarlo sin consola usa un acceso directo con la opción de inicio minimizado.
