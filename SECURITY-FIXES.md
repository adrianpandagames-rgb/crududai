# Correcciones de seguridad

Cambios aplicados el 9 de octubre de 2026 sobre el código actual, sin reiniciar
servicios ni ejecutar migraciones o llamadas a proveedores.

- `/api/ubicaciones` y `/estudiantes` exigen autenticación.
- Login y cambios autenticados comprueban el origen HTTPS de la petición.
  Clientes que envían cookies deben incluir `Origin` del servidor o un
  `Referer` del mismo origen. El puerto forma parte del origen.
- Las cookies de sesión incluyen `Secure` y `HttpOnly`.
- Las sesiones se vinculan al hash de contraseña vigente. Restablecerla revoca
  todos los tokens; cambiarla revoca otras sesiones y rota el token actual.
  La actualización condicional impide que una petición anterior a un reset
  sobrescriba la contraseña recién restablecida.
- Los modales de duplicados crean celdas con `textContent`, sin interpretar
  metadata o parámetros de URL como HTML. Se muestran hasta 20 coincidencias.
- La importación de contactos admite un archivo de hasta 5 MiB y 10000 filas,
  con límites de campos multipart y respuestas de coincidencias acotadas.
- El proveedor telefónico se consulta mediante HTTPS, sin fallback a HTTP.
  El plan del proveedor debe permitir HTTPS; ante un error no se degrada
  la seguridad del transporte.

## Certificados y activación

Las claves antiguas y sus certificados se retiraron del índice de Git,
conservando los archivos locales. El historial previo todavía puede contenerlos;
no se reescribió el historial compartido.

El siguiente arranque ya no seleccionará automáticamente esos archivos. Si no
hay configuración TLS explícita, generará un nuevo par local en
`certs/runtime-server.key` y `certs/runtime-server.crt`. El navegador puede
mostrar una advertencia de confianza por el certificado nuevo. Los certificados
y respaldos locales quedan ignorados por Git.

Para una identidad TLS confiable, emitir un par nuevo y configurar conjuntamente
`TLS_KEY_PATH` y `TLS_CERT_PATH`; también pueden apuntar a archivos externos al
repositorio. Si falta uno de los archivos configurados, el arranque falla sin
sobrescribir credenciales. No reutilizar claves expuestas en el historial.
En Docker estas rutas deben existir dentro del contenedor, con permisos de lectura
para el usuario `node`; el volumen `certificates` conserva el par local nuevo.

Los cambios entran en vigor al reiniciar el proceso con este código o reconstruir
y reiniciar su contenedor. No se realizó ese reinicio sobre un servicio compartido.

## Validación

Se añadieron casos de regresión para origen de login y atributos de cookies.
Se comprobó la sintaxis sin ejecutar el servidor ni importar módulos del objetivo.
La suite funcional queda pendiente en un entorno aislado: el entorno actual no
acredita los controles OS exigidos por la skill de auditoría. La suite completa
puede abrir la base real al importar el router y contiene un test antiguo que
referencia `src/authCookies.js`, actualmente ausente.

Antes de desplegar, validar con DB y usuarios ficticios: rechazo anónimo de las
dos rutas, rechazo de login entre orígenes, revocación después del reset,
rotación después del cambio, metadata HTML mostrada como texto y rechazo de
CSV que exceda los límites. Verificar los flujos de carga y el login usando el
origen HTTPS real, y el proveedor con una respuesta simulada, sin consumir cuota.
