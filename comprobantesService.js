/**
 * @file comprobantesService.js
 * @description Servicio unificado para glaukapi. Lógica limpia de cruce por JID/Grupo.
 */

const db = require('./db');

// Formatear URL base de TasasHub de forma transparente
let rawHubUrl = process.env.TASASHUB_URL || 'https://automat-tasashub.fyi6ur.easypanel.host';
if (!rawHubUrl.includes('/api/v1/tasas/calcular')) {
  rawHubUrl = rawHubUrl.replace(/\/+$/, '') + '/api/v1/tasas/calcular';
}
const TASASHUB_BASE_URL = rawHubUrl;
const REMITHUB_BASE_URL = process.env.REMITHUB_URL || 'https://automat-remithub.fyi6ur.easypanel.host/api/comprobantes';

/**
 * Cruce estricto en perfiles_glaukov por Nombre o por JID de WhatsApp (id_grupo).
 */
async function obtenerPerfil(identificador) {
  if (!identificador || identificador === 'GENERAL' || identificador === 'NO DEFINIDO') return null;

  try {
    const val = String(identificador).trim();

    // Busca coincidencia en la columna 'nombre' O en la columna 'id_grupo' (JID)
    const query = `
      SELECT nombre, id_grupo, moneda_base, monedas 
      FROM perfiles_glaukov 
      WHERE UPPER(TRIM(nombre)) = UPPER(TRIM($1))
         OR UPPER(TRIM(COALESCE(id_grupo, ''))) = UPPER(TRIM($1))
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [val]);
    if (!rows[0]) return null;

    const perfil = rows[0];
    if (typeof perfil.monedas === 'string') {
      try { perfil.monedas = JSON.parse(perfil.monedas); } catch (e) { perfil.monedas = {}; }
    }
    return perfil;
  } catch (err) {
    console.warn(`[glaukapi ⚠️ Error DB buscando perfil ${identificador}]:`, err.message);
    return null;
  }
}

/**
 * Consulta el lote de cotización en tasas_glaukov.
 */
async function obtenerLoteTasasGlaukov(idLote) {
  if (!idLote) return null;
  try {
    const query = `
      SELECT id_tasa, tasas, fecha 
      FROM tasas_glaukov 
      WHERE UPPER(TRIM(id_tasa)) = UPPER(TRIM($1)) 
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [idLote]);
    if (!rows[0]) return null;

    const loteObj = rows[0];
    if (typeof loteObj.tasas === 'string') {
      try { loteObj.tasas = JSON.parse(loteObj.tasas); } catch (e) { loteObj.tasas = {}; }
    }
    return loteObj;
  } catch (err) {
    return null;
  }
}

/**
 * Consulta TasasHub con el identificador resuelto.
 */
async function consultarTasasHub(identificador, lote) {
  if (!identificador || identificador === 'GENERAL' || identificador === 'NO DEFINIDO') return null;

  try {
    const targetQuery = encodeURIComponent(String(identificador).trim());
    const loteQuery = lote ? `?lote=${encodeURIComponent(String(lote).trim())}` : '';
    const url = `${TASASHUB_BASE_URL}/${targetQuery}${loteQuery}`;

    const res = await fetch(url);
    if (!res.ok) return null;
    return await res.json();
  } catch (err) {
    return null;
  }
}

/**
 * Extrae la tasa exacta (compra o venta) de TasasHub.
 */
function extraerTasaHub(dataHub, moneda, naturaleza) {
  if (!dataHub || !Array.isArray(dataHub.tarjetas_paises)) return 'N/A';

  const mon = String(moneda || '').trim().toUpperCase();
  const nat = String(naturaleza || '').trim().toUpperCase();

  const tarjeta = dataHub.tarjetas_paises.find(t => String(t.code || '').trim().toUpperCase() === mon);
  if (!tarjeta) return 'N/A';

  if (nat === 'D') {
    const val = Number(tarjeta.compra);
    return !isNaN(val) && val > 0 ? val : 'N/A';
  }
  if (nat === 'P') {
    const val = Number(tarjeta.venta);
    return !isNaN(val) && val > 0 ? val : 'N/A';
  }
  return 'N/A';
}

/**
 * Procesa un comprobante con contrato JSON limpio (Un solo campo por Grupo).
 */
async function procesarComprobante(item) {
  const lote = String(item.lote_tasa || item.lote_tasa_asignado || item.id_tasa || 'T001').trim();
  const monto = Math.abs(Number(item.monto || item.monto_local || 0));
  const moneda = String(item.moneda || item.moneda_local || '').trim().toUpperCase();

  // 1. Recibir los JIDs o nombres raw de los grupos
  const raw1 = item.grupo_raw_1 || item.nombre_socio_1 || item.socio_1 || item.grupo_1 || 'GENERAL';
  const raw2 = item.grupo_raw_2 || item.nombre_socio_2 || item.socio_2 || item.grupo_2 || 'GENERAL';

  // 2. Cruce obligatorio con PostgreSQL perfiles_glaukov
  const [perfil1, perfil2, loteGlaukov] = await Promise.all([
    obtenerPerfil(raw1),
    obtenerPerfil(raw2),
    obtenerLoteTasasGlaukov(lote)
  ]);

  // Si encontró en DB usas perfil1.nombre; si no, usas la cadena raw
  const g1Identificador = perfil1?.nombre || raw1;
  const g2Identificador = perfil2?.nombre || raw2;

  // 3. Consulta a TasasHub usando el identificador resuelto
  const [dataHub1, dataHub2] = await Promise.all([
    consultarTasasHub(g1Identificador, lote),
    consultarTasasHub(g2Identificador, lote)
  ]);

  const monBase1 = String(perfil1?.moneda_base || 'USDT').trim().toUpperCase();
  const monBase2 = String(perfil2?.moneda_base || 'USDT').trim().toUpperCase();

  // 4. Naturaleza / Tipo de operación (A, D, P)
  let tipoCalculado = item.tipo || item.tipo_op1 || item.naturaleza;
  if (!tipoCalculado || tipoCalculado === 'D') {
    if (moneda && monBase1 && moneda === monBase1) tipoCalculado = 'A';
    else if (perfil1?.monedas?.[moneda]?.tipo) tipoCalculado = perfil1.monedas[moneda].tipo;
    else if (moneda !== monBase1 && moneda !== '') tipoCalculado = 'P';
    else tipoCalculado = 'D';
  }

  // 5. Cálculo de Tasas
  let tasa1 = (tipoCalculado === 'A' || monBase1 === moneda) ? 1.00 : extraerTasaHub(dataHub1, moneda, tipoCalculado);
  let tasa2 = (tipoCalculado === 'A' || monBase2 === moneda) ? 1.00 : extraerTasaHub(dataHub2, moneda, tipoCalculado);

  const numT1 = Number(tasa1);
  const numT2 = Number(tasa2);

  const monto1 = !isNaN(numT1) && numT1 > 0 ? Number((monto / numT1).toFixed(2)) : monto;
  const monto2 = !isNaN(numT2) && numT2 > 0 ? Number((monto / numT2).toFixed(2)) : monto;

  const tasaMeBase = Number(loteGlaukov?.tasas?.[moneda] || 1);
  const me1 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto1;
  const me2 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto2;

  // JSON final con estructura unificada única
  return {
    comprobante: {
      lote,
      monto,
      moneda,
      banco: item.banco || item.entidad || '',
      titular: item.titular || item.nombre_titular || '',
      referencia: item.referencia || item.ref || '',
      tipo: tipoCalculado,
      link_img: item.url_r2_comprobante || item.link_img || item.url_imagen || '',
      grupo_1: {
        grupo: g1Identificador,
        tasa: tasa1,
        polaridad: perfil1?.monedas?.[moneda]?.polaridad || '+',
        monto: monto1,
        moneda_base: monBase1,
        me: me1
      },
      grupo_2: {
        grupo: g2Identificador,
        tasa: tasa2,
        polaridad: perfil2?.monedas?.[moneda]?.polaridad || '+',
        monto: monto2,
        moneda_base: monBase2,
        me: me2
      }
    }
  };
}

module.exports = { procesarComprobante };
