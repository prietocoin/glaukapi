/**
 * @file comprobantesService.js
 * Lógica determinista con resolución dinámica de lote por fecha de primer impacto.
 */

const db = require('./db');

let rawHubUrl = process.env.TASASHUB_URL || 'https://automat-tasashub.fyi6ur.easypanel.host';
if (!rawHubUrl.includes('/api/v1/tasas/calcular')) {
  rawHubUrl = rawHubUrl.replace(/\/+$/, '') + '/api/v1/tasas/calcular';
}
const TASASHUB_BASE_URL = rawHubUrl;

function normalizarCodigoMoneda(moneda) {
  const mon = String(moneda || '').trim().toUpperCase();
  if (mon === 'VES' || mon === 'VEF' || mon === 'VED' || mon === 'BS') return ['VES', 'BS', 'VEF', 'VED'];
  if (mon === 'PEN' || mon === 'SOL' || mon === 'SOLES') return ['PEN', 'SOL', 'SOLES'];
  if (mon === 'ARS' || mon === 'ARG') return ['ARS', 'ARG'];
  if (mon === 'COP') return ['COP'];
  if (mon === 'USD' || mon === 'USDT') return ['USD', 'USDT'];
  return [mon];
}

async function obtenerPerfilGrupo(identificador) {
  if (!identificador || identificador === 'GENERAL' || identificador === 'NO DEFINIDO') return null;

  try {
    const rawVal = String(identificador).trim();
    const numericPart = rawVal.split('@')[0];

    const query = `
      SELECT id_grupo, nombre, moneda_base, monedas 
      FROM perfiles_glaukov 
      WHERE UPPER(TRIM(id_grupo)) = UPPER(TRIM($1))
         OR UPPER(TRIM(nombre)) = UPPER(TRIM($1))
         OR id_grupo LIKE $2
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [rawVal, `%${numericPart}%`]);
    if (!rows[0]) return null;

    const perfil = rows[0];
    if (typeof perfil.monedas === 'string') {
      try { perfil.monedas = JSON.parse(perfil.monedas); } catch (e) { perfil.monedas = {}; }
    }
    return perfil;
  } catch (err) {
    console.error(`[glaukapi ❌ Error DB Perfiles]:`, err.message);
    return null;
  }
}

/**
 * 🟢 BUSCAR LOTE DINÁMICO POR FECHA DE PRIMER IMPACTO
 * Encuentra el lote publicado en tasas_glaukov con la fecha más próxima anterior o igual.
 */
async function obtenerLoteTasasPorFecha(fechaImpacto, idLoteForzado = null) {
  try {
    // Si viene un id_tasa/lote explícito en el comprobante, intentar buscarlo directamente primero
    if (idLoteForzado) {
      const { rows } = await db.query(
        'SELECT id_tasa, tasas, fecha FROM tasas_glaukov WHERE UPPER(TRIM(id_tasa)) = UPPER(TRIM($1)) LIMIT 1;',
        [idLoteForzado]
      );
      if (rows[0]) {
        const loteObj = rows[0];
        if (typeof loteObj.tasas === 'string') {
          try { loteObj.tasas = JSON.parse(loteObj.tasas); } catch (e) { loteObj.tasas = {}; }
        }
        return loteObj;
      }
    }

    // Si no hay lote forzado o no existe, buscar por fecha <= fechaImpacto
    const targetDate = fechaImpacto ? new Date(fechaImpacto) : new Date();

    const query = `
      SELECT id_tasa, tasas, fecha 
      FROM tasas_glaukov 
      WHERE fecha <= $1 
      ORDER BY fecha DESC 
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [targetDate]);

    // Fallback: si el comprobante es más antiguo que cualquier registro, traer la tasa publicada más antigua disponible
    let loteObj = rows[0];
    if (!loteObj) {
      const fallbackQuery = 'SELECT id_tasa, tasas, fecha FROM tasas_glaukov ORDER BY fecha ASC LIMIT 1;';
      const fallbackRes = await db.query(fallbackQuery);
      loteObj = fallbackRes.rows[0];
    }

    if (!loteObj) return null;

    if (typeof loteObj.tasas === 'string') {
      try { loteObj.tasas = JSON.parse(loteObj.tasas); } catch (e) { loteObj.tasas = {}; }
    }
    return loteObj;

  } catch (err) {
    console.error(`[glaukapi ❌ Error buscando Lote por fecha ${fechaImpacto}]:`, err.message);
    return null;
  }
}

async function consultarTasasHub(nombreGrupo, idLote) {
  if (!nombreGrupo || nombreGrupo === 'GENERAL' || nombreGrupo === 'NO DEFINIDO') return null;
  if (String(nombreGrupo).includes('@g.us')) return null;

  try {
    const grupoQuery = encodeURIComponent(String(nombreGrupo).trim());
    const loteQuery = idLote ? `?lote=${encodeURIComponent(String(idLote).trim())}` : '';
    const url = `${TASASHUB_BASE_URL}/${grupoQuery}${loteQuery}`;

    const res = await fetch(url);
    if (!res.ok) return null;
    
    const json = await res.json();
    return json?.data || json;
  } catch (err) {
    console.warn(`[glaukapi ⚠️ TasasHub Fetch Error]:`, err.message);
    return null;
  }
}

function extraerTasaHub(dataHub, moneda, naturaleza) {
  if (!dataHub || !Array.isArray(dataHub.tarjetas_paises)) return 'N/A';

  const codigosAceptados = normalizarCodigoMoneda(moneda);
  const nat = String(naturaleza || '').trim().toUpperCase();

  const tarjeta = dataHub.tarjetas_paises.find(t => {
    const codeTarjeta = String(t.code || t.moneda || '').trim().toUpperCase();
    return codigosAceptados.includes(codeTarjeta);
  });

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

async function procesarComprobante(item) {
  const monto = Math.abs(Number(item.monto || item.monto_local || 0));
  const moneda = String(item.moneda || item.moneda_local || '').trim().toUpperCase();

  // 1. Obtener la Fecha de Primer Impacto del Comprobante
  const fechaImpacto = item.created_at || item.fecha || item.fecha_creacion || item.timestamp || new Date();
  const idLoteExplicit = item.lote_tasa || item.lote_tasa_asignado || item.id_tasa;

  // 2. Extraer identificadores raw de grupos
  const rawGrupo1 = item.id_grupo_1 || item.grupo_raw_1 || item.nombre_socio_1 || item.socio_1 || item.grupo_1 || item.id_chat || 'GENERAL';
  const rawGrupo2 = item.id_grupo_2 || item.grupo_raw_2 || item.nombre_socio_2 || item.socio_2 || item.grupo_2 || 'GENERAL';

  // 3. Resolver perfiles y obtener el Lote por la fecha más próxima anterior
  const [perfil1, perfil2, loteGlaukov] = await Promise.all([
    obtenerPerfilGrupo(rawGrupo1),
    obtenerPerfilGrupo(rawGrupo2),
    obtenerLoteTasasPorFecha(fechaImpacto, idLoteExplicit)
  ]);

  const loteCodigo = loteGlaukov?.id_tasa || 'T001';
  const nombreGrupo1 = perfil1?.nombre || rawGrupo1;
  const nombreGrupo2 = perfil2?.nombre || rawGrupo2;

  // 4. Consultar TasasHub enviando el código de lote dinámico resuelto
  const [dataHub1, dataHub2] = await Promise.all([
    consultarTasasHub(nombreGrupo1, loteCodigo),
    consultarTasasHub(nombreGrupo2, loteCodigo)
  ]);

  const monBase1 = String(perfil1?.moneda_base || 'USDT').trim().toUpperCase();
  const monBase2 = String(perfil2?.moneda_base || 'USDT').trim().toUpperCase();

  // 5. Determinar Naturaleza de la Operación (A, D, P)
  let tipoCalculado = item.tipo || item.tipo_op1 || item.naturaleza;
  if (!tipoCalculado || tipoCalculado === 'D') {
    if (moneda && monBase1 && moneda === monBase1) tipoCalculado = 'A';
    else if (perfil1?.monedas?.[moneda]?.tipo) tipoCalculado = perfil1.monedas[moneda].tipo;
    else if (moneda !== monBase1 && moneda !== '') tipoCalculado = 'P';
    else tipoCalculado = 'D';
  }

  // 6. Extracción de Tasas T1 / T2
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
      lote: loteCodigo,
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
