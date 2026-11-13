// Every migration, in the order it runs. A new one goes at the end with the next number; an applied one never changes.
import nombresTablasOficios from './001-nombres-tablas-oficios.js';
import collationUnica from './002-collation-unica.js';
import indicesUnicos from './003-indices-unicos-contactos-imei.js';

export default [nombresTablasOficios, collationUnica, indicesUnicos];
