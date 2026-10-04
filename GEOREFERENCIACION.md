# Georeferenciación con Google

Acceso exclusivo para administradores desde el menú Administración. Todas las rutas de consulta, carga, exportación y eliminación rechazan usuarios sin permisos de administrador.

Cada resultado exitoso se guarda en `georeferenciacion_ubicaciones`, con `ubicacion`, `lugar`, `latitude` y `longitude`, además de un identificador interno. Las coordenadas son únicas: una nueva consulta de las mismas coordenadas actualiza la dirección y el lugar. Estos registros no vencen con los archivos y se muestran con búsqueda y paginación dentro de Georeferenciación. No se guardan coordenadas inválidas ni respuestas sin resultados. La tabla se crea al acceder al módulo o mediante `node scripts/add-georeferenciacion-ubicaciones.js`.

Configura `GOOGLE_GEOCODING_API_KEY` en `.env` y reinicia la aplicación. Utiliza una clave de servidor con Geocoding API y facturación habilitadas, restringida a esa API y a las IP de salida del servidor. La clave no se envía al navegador ni se guarda en los archivos.

Configuración oficial: https://developers.google.com/maps/documentation/geocoding/guides-v3/get-api-key

En **Georeferenciación**, ingresa una línea e importa un CSV o XLSX de hasta 20 MB y 100000 filas. Para Excel se utiliza la primera hoja. Incluye encabezados `latitud`/`latitude`/`lat` y `longitud`/`longitude`/`lon`/`lng`/`long`. Se aceptan coordenadas decimales y grados, minutos y segundos; los CSV separados por punto y coma admiten coma decimal.

Se mantienen las filas y las demás columnas. Se actualizan o agregan:

- `antena`: número consecutivo por coordenada válida diferente.
- `ubicacion`: primera dirección formateada devuelta por Google en español.
- `lugar`: localidad; si no existe, municipio o estado.
- `estado_geocodificacion`: `OK`, `SIN_RESULTADOS` o `COORDENADAS_INVALIDAS`.

Cada coordenada distinta genera una consulta por archivo, con posibles cargos en Google. La dirección se consulta en Google. Además del catálogo de ubicaciones guardadas, la base de datos almacena el seguimiento y los resultados del trabajo en la tabla independiente `georeferenciacion_archivos`, creada automáticamente. Los resultados se pueden descargar en CSV o XLSX durante 48 horas; cada administrador solo accede a sus archivos, mientras que el catálogo de ubicaciones es compartido entre administradores. Los archivos vencidos se eliminan al acceder al módulo.

Los trabajos se procesan secuencialmente dentro de una instancia de la aplicación. La pantalla actualiza los estados cada cinco segundos. Eliminar un trabajo cancela las consultas pendientes. Los errores de Google detienen el trabajo; no se reintentan automáticamente para evitar repetir consultas facturables. Si se reinicia el servidor, los trabajos pendientes se marcan como error al abrir el módulo; deben importarse nuevamente. Los archivos ya terminados permanecen disponibles hasta su vencimiento.

La implementación supone una sola instancia del servidor, como la gestión de sesiones actual. No distribuye trabajos entre réplicas.

Referencia de geocodificación inversa: https://developers.google.com/maps/documentation/geocoding/guides-v3/requests-reverse-geocoding
