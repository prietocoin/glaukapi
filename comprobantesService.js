/**
 * @file comprobantesService.js
 * @description Servicio de resolución determinista para glaukapi por id_grupo (JID) / perfiles_glaukov.
 */

const db = require('./db');

// Formatear URL base de TasasHub asegurando endpoint completo
let rawHubUrl = process.env.TASASHUB_URL || 'https://automat-tasashub.fyi6ur.easypanel.host';
if (!rawHubUrl.includes('/api/v1/tasas/calcular')) {
  rawHubUrl = rawHubUrl.replace(/\/+$/, '') + '/api/v1/tasas/calcular';
}
const TASASHUB_BASE_URL = rawHubUrl;
const REMITHUB_BASE_URL = process.env.REMITHUB_URL || 'https://automat-remithub.fyi6ur.easypanel.host/api/comprobantes';

/**
 * Busca en perfiles_glaukov haciendo cruce por id_grupo (JID) o por nombre de grupo.
 */
async function obtenerPerfilGrupo(identificador) {
  if (!identificador || identificador === 'GENERAL' || identificador === 'NO DEFINIDO') return null;

  try {
    const val = String(identificador).trim();

    // Cruce directo contra id_grupo (JID) o nombre
    const query = `
      SELECT id_grupo, nombre, moneda_base, monedas 
      FROM perfiles_glaukov 
      WHERE UPPER(TRIM(id_grupo)) = UPPER(TRIM($1))
         OR UPPER(TRIM(nombre)) = UPPER(TRIM($1))
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
    console.warn(`[glaukapi ⚠️ DB Error Perfil Grupo ${identificador}]:`, err.message);
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
 * Consulta TasasHub enviando el nombre legible del grupo y el lote.
 */
async function consultarTasasHub(nombreGrupo, lote) {
  if (!nombreGrupo || nombreGrupo === 'GENERAL' || nombreGrupo === 'NO DEFINIDO') return null;

  try {
    const grupoQuery = encodeURIComponent(String(nombreGrupo).trim());
    const loteQuery = lote ? `?lote=${encodeURIComponent(String(lote).trim())}` : '';
    const url = `${TASASHUB_BASE_URL}/${grupoQuery}${loteQuery}`;

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
 * Procesa un comprobante individual cruzando id_grupo -> nombre y resolviendo tasas.
 */
async function procesarComprobante(item) {
  const lote = String(item.lote_tasa || item.lote_tasa_asignado || item.id_tasa || 'T001').trim();
  const monto = Math.abs(Number(item.monto || item.monto_local || 0));
  const moneda = String(item.moneda || item.moneda_local || '').trim().toUpperCase();

  // 1. Extraer los JIDs/identificadores raw del comprobante
  const rawGrupo1 = item.grupo_raw_1 || item.nombre_socio_1 || item.socio_1 || item.grupo_1 || 'GENERAL';
  const rawGrupo2 = item.grupo_raw_2 || item.nombre_socio_2 || item.socio_2 || item.grupo_2 || 'GENERAL';

  // 2. Cruce obligatorio con perfiles_glaukov por id_grupo (JID)
  const [perfil1, perfil2, loteGlaukov] = await Promise.all([
    obtenerPerfilGrupo(rawGrupo1),
    obtenerPerfilGrupo(rawGrupo2),
    obtenerLoteTasasGlaukov(lote)
  ]);

  // Si cruzó en la DB, tomamos el nombre del grupo; si no, dejamos la cadena original
  const nombreGrupo1 = perfil1?.nombre || rawGrupo1;
  const nombreGrupo2 = perfil2?.nombre || rawGrupo2;

  // 3. Consultar a TasasHub usando el nombre del grupo resuelto (ej: "YARELIS")
  const [dataHub1, dataHub2] = await Promise.all([
    consultarTasasHub(nombreGrupo1, lote),
    consultarTasasHub(nombreGrupo2, lote)
  ]);

  const monBase1 = String(perfil1?.moneda_base || 'USDT').trim().toUpperCase();
  const monBase2 = String(perfil2?.moneda_base || 'USDT').trim().toUpperCase();

  // 4. Determinar Naturaleza de la Operación (A, D, P)
  let tipoCalculado = item.tipo || item.tipo_op1 || item.naturaleza;
  if (!tipoCalculado || tipoCalculado === 'D') {
    if (moneda && monBase1 && moneda === monBase1) tipoCalculado = 'A';
    else if (perfil1?.monedas?.[moneda]?.tipo) tipoCalculado = perfil1.monedas[moneda].tipo;
    else if (moneda !== monBase1 && moneda !== '') tipoCalculado = 'P';
    else tipoCalculado = 'D';
  }

  // 5. Extracción de Tasas T1 / T2 desde TasasHub
  let tasa1 = (tipoCalculado === 'A' || monBase1 === moneda) ? 1.00 : extraerTasaHub(dataHub1, moneda, tipoCalculado);
  let tasa2 = (tipoCalculado === 'A' || monBase2 === moneda) ? 1.00 : extraerTasaHub(dataHub2, moneda, tipoCalculado);

  const numT1 = Number(tasa1);
  const numT2 = Number(tasa2);

  const monto1 = !isNaN(numT1) && numT1 > 0 ? Number((monto / numT1).toFixed(2)) : monto;
  const monto2 = !isNaN(numT2) && numT2 > 0 ? Number((monto / numT2).toFixed(2)) : monto;

  const tasaMeBase = Number(loteGlaukov?.tasas?.[moneda] || 1);
  const me1 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto1;
  const me2 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto2;

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
        grupo: nombreGrupo1,
        tasa: tasa1,
        polaridad: perfil1?.monedas?.[moneda]?.polaridad || '+',
        monto: monto1,
        moneda_base: monBase1,
        me: me1
      },
      grupo_2: {
        grupo: nombreGrupo2,
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
