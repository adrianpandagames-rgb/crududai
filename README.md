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
   source BD/estudiantes.sql;
   source BD/imei.sql;
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

> Si no se define una API key de IMEI, la aplicación intentará usar una por defecto, aunque su disponibilidad puede variar.

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
