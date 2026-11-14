// Every migration, in the order it runs. A new one goes at the end with the next number; an applied one never changes.
import nombresTablasOficios from './001-nombres-tablas-oficios.js';
import collationUnica from './002-collation-unica.js';
import indicesUnicos from './003-indices-unicos-contactos-imei.js';
import casosYDelitos from './004-casos-y-delitos.js';
import oficiosConCaso from './005-oficios-con-caso.js';
import lineas from './006-lineas.js';
import auditoriaRegistroCambios from './007-auditoria-registro-cambios.js';

export default [nombresTablasOficios, collationUnica, indicesUnicos, casosYDelitos, oficiosConCaso, lineas, auditoriaRegistroCambios];
