# CRUD UDAI

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

## Configuración

Crea un archivo .env en la raíz del proyecto con las siguientes variables:

```env
DB_HOST=localhost
DB_USER=root
DB_PASSWORD=tu_password
DB_NAME=crudnodejs

HOST=0.0.0.0
PORT=3600
HTTPS_PORT=3443

IMEI_API_KEY=tu_api_key
IMEI_SERVICE_ID=0
```

> Nunca guardes claves reales en el repositorio. Usa variables de entorno locales en un archivo .env no versionado, y deja placeholders en .env.example o documentación.

## Ejecución

Inicia el servidor en modo desarrollo:

```bash
npm run dev
```

O en modo producción:

```bash
npm start
```

La aplicación quedará disponible en:

- HTTP: http://localhost:3600
- HTTPS: https://localhost:3443

El puerto HTTP redirige automáticamente a HTTPS.

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

