import { fuentesMetricas } from './metricasService.js';

export function validarConsultaRegistros(tipo, pagina = '1') {
  const fuente = fuentesMetricas.find(item => item.tipo === tipo);
  if (!fuente) throw new Error('Selecciona un tipo de registro válido.');
  if (typeof pagina !== 'string' || !/^\d+$/.test(pagina) || !Number.isSafeInteger(Number(pagina)) || Number(pagina) < 1) throw new Error('Página inválida.');
  return { fuente, pagina: Number(pagina) };
}

export async function listarRegistrosCarpetas(db, tipo, pagina = '1') {
  const consulta = validarConsultaRegistros(tipo, pagina);
  const tabla = consulta.fuente.tabla;
  const [[conteo]] = await db.execute(`SELECT COUNT(*) AS total FROM ${tabla}`);
  const total = Number(conteo.total);
  const paginas = Math.max(1, Math.ceil(total / 5));
  const actual = Math.min(consulta.pagina, paginas);
  const [registros] = await db.query(`SELECT id, nuc,
    DATE_FORMAT(fecha_envio, '%d/%m/%Y') AS fecha_envio, agencia, ciudad
    FROM ${tabla} ORDER BY id DESC LIMIT ? OFFSET ?`, [5, (actual - 1) * 5]);
  return { tipo, registros, total, pagina: actual, paginas };
}
