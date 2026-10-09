/**
 * @file comprobantesService.js
 * Lógica determinista con herencia explícita mapeada hacia FUNDDA.
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

function parsearTimestampMsg(ts) {
  if (!ts) return new Date();
  if (typeof ts === 'string' && ts.includes('T')) {
    const d = new Date(ts);
    if (!isNaN(d.getTime())) return d;
  }
  const num = Number(ts);
  if (isNaN(num) || num <= 0) return new Date();
  if (String(num).length === 10) return new Date(num * 1000);
  return new Date(num);
}

/**
 * Consulta el perfil matriz de FUNDDA
 */
async function obtenerPerfilMatrizFundda() {
  try {
    const { rows } = await db.query(`
      SELECT id_grupo, nombre, moneda_base, monedas, herencia 
      FROM perfiles_glaukov 
      WHERE UPPER(TRIM(nombre)) = 'FUNDDA' OR id_grupo = '120363401374720092@g.us'
      LIMIT 1;
    `);
    if (!rows[0]) return null;

    const perfil = rows[0];
    if (typeof perfil.monedas === 'string') {
      try { perfil.monedas = JSON.parse(perfil.monedas); } catch (e) { perfil.monedas = {}; }
    }
    return perfil;
  } catch (err) {
    console.error(`[glaukapi ❌ Error DB FUNDDA]:`, err.message);
    return null;
  }
}

/**
 * Obtener perfil del grupo en Postgres
 */
async function obtenerPerfilGrupo(identificador) {
  if (!identificador || identificador === 'GENERAL' || identificador === 'NO DEFINIDO') {
    return null;
  }

  try {
    const rawVal = String(identificador).trim();
    const numericPart = rawVal.split('@')[0];

    const query = `
      SELECT id_grupo, nombre, moneda_base, monedas, herencia 
      FROM perfiles_glaukov 
      WHERE UPPER(TRIM(id_grupo)) = UPPER(TRIM($1))
         OR UPPER(TRIM(nombre)) = UPPER(TRIM($1))
         OR id_grupo LIKE $2
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [rawVal, `%${numericPart}%`]);

    if (!rows[0]) return null;

    let perfil = rows[0];
    if (typeof perfil.monedas === 'string') {
      try { perfil.monedas = JSON.parse(perfil.monedas); } catch (e) { perfil.monedas = {}; }
    }

    // 🟢 SI HERENCIA ES TRUE: Apuntamos el identificador de consulta hacia FUNDDA
    if (perfil.herencia === true) {
      const matrizFundda = await obtenerPerfilMatrizFundda();
      perfil.grupo_tasashub = 'FUNDDA'; // Entidad a consultar en TasasHub
      if (matrizFundda && matrizFundda.monedas) {
        perfil.monedas = matrizFundda.monedas;
      }
      if (!perfil.moneda_base && matrizFundda?.moneda_base) {
        perfil.moneda_base = matrizFundda.moneda_base;
      }
    } else {
      perfil.grupo_tasashub = perfil.nombre;
    }

    return perfil;
  } catch (err) {
    console.error(`[glaukapi ❌ Error DB Perfiles]:`, err.message);
    return null;
  }
}

function socioTieneMonedaConfigurada(perfil, moneda) {
  if (!perfil || !perfil.monedas) return false;
  const codigos = normalizarCodigoMoneda(moneda);
  const keyMoneda = Object.keys(perfil.monedas).find(m => codigos.includes(m.toUpperCase()));
  if (!keyMoneda) return false;

  const config = perfil.monedas[keyMoneda];
  return config && config.activo !== false;
}

function obtenerPolaridadPorTipo(perfil, moneda, tipoCalculado, esSocio1 = true) {
  if (tipoCalculado === 'A') return esSocio1 ? '+' : '-';
  if (!perfil || !perfil.monedas) return '+';

  const codigos = normalizarCodigoMoneda(moneda);
  const keyMoneda = Object.keys(perfil.monedas).find(m => codigos.includes(m.toUpperCase()));
  if (!keyMoneda) return '+';

  const configMoneda = perfil.monedas[keyMoneda];

  if (tipoCalculado === 'D') {
    return configMoneda.polar_D !== undefined ? configMoneda.polar_D : (configMoneda.polaridad || '+');
  }
  if (tipoCalculado === 'P') {
    return configMoneda.polar_P !== undefined ? configMoneda.polar_P : (configMoneda.polaridad || '-');
  }

  return '+';
}

async function obtenerLoteTasasPorFecha(timestampMsg) {
  try {
    const fechaRemitHub = parsearTimestampMsg(timestampMsg);

    const query = `
      SELECT id_tasa, tasas, created_at 
      FROM tasas_glaukov 
      WHERE created_at <= $1 
      ORDER BY created_at DESC 
      LIMIT 1;
    `;
    const { rows } = await db.query(query, [fechaRemitHub]);
    let loteObj = rows[0];

    if (!loteObj) {
      const fallbackRes = await db.query('SELECT id_tasa, tasas, created_at FROM tasas_glaukov ORDER BY created_at ASC LIMIT 1;');
      loteObj = fallbackRes.rows[0];
    }

    if (!loteObj) return null;

    if (typeof loteObj.tasas === 'string') {
      try { loteObj.tasas = JSON.parse(loteObj.tasas); } catch (e) { loteObj.tasas = {}; }
    }
    return loteObj;
  } catch (err) {
    console.error(`[glaukapi ❌ Error Lote Query]:`, err.message);
    return null;
  }
}

async function consultarTasasHub(nombreGrupo, idLote) {
  if (!nombreGrupo || nombreGrupo === 'GENERAL' || nombreGrupo === 'NO DEFINIDO') return null;
  if (String(nombreGrupo).includes('@g.us')) return null;

  try {
    const grupoQuery = encodeURIComponent(String(nombreGrupo).trim());
    const loteQuery = idLote ? `?lote=${encodeURIComponent(String(lote).trim())}` : '';
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

  const compra = Number(tarjeta.compra);
  const venta = Number(tarjeta.venta);

  if (nat === 'D') {
    if (!isNaN(compra) && compra > 0) return compra;
    if (!isNaN(venta) && venta > 0) return venta;
  }
  if (nat === 'P') {
    if (!isNaN(venta) && venta > 0) return venta;
    if (!isNaN(compra) && compra > 0) return compra;
  }

  return !isNaN(compra) && compra > 0 ? compra : (!isNaN(venta) && venta > 0 ? venta : 'N/A');
}

async function procesarComprobante(item) {
  const monto = Math.abs(Number(item.monto || item.monto_local || 0));
  const moneda = String(item.moneda || item.moneda_local || '').trim().toUpperCase();

  const tsMsg = item.timestamp_msg || item.created_at || item.fecha;

  const rawGrupo1 = item.id_grupo_1 || item.grupo_raw_1 || item.nombre_socio_1 || item.socio_1 || item.grupo_1 || item.id_chat || 'GENERAL';
  const rawGrupo2 = item.id_grupo_2 || item.grupo_raw_2 || item.nombre_socio_2 || item.socio_2 || item.grupo_2 || 'GENERAL';

  // 1. Resolver perfiles
  const [perfil1, perfil2, loteGlaukov] = await Promise.all([
    obtenerPerfilGrupo(rawGrupo1),
    obtenerPerfilGrupo(rawGrupo2),
    obtenerLoteTasasPorFecha(tsMsg)
  ]);

  const loteCodigo = loteGlaukov?.id_tasa || 'T001';

  const nombreGrupo1 = perfil1?.nombre || rawGrupo1;
  const nombreGrupo2 = perfil2?.nombre || rawGrupo2;

  // 2. Verificar pool de monedas
  const tieneMonedaS1 = socioTieneMonedaConfigurada(perfil1, moneda);
  const tieneMonedaS2 = socioTieneMonedaConfigurada(perfil2, moneda);

  // 🟢 SI TIENE HERENCIA TRUE -> Consulta TasasHub con "FUNDDA"
  const targetTasas1 = perfil1?.grupo_tasashub || nombreGrupo1;
  const targetTasas2 = perfil2?.grupo_tasashub || nombreGrupo2;

  const [dataHub1, dataHub2] = await Promise.all([
    tieneMonedaS1 ? consultarTasasHub(targetTasas1, loteCodigo) : null,
    tieneMonedaS2 ? consultarTasasHub(targetTasas2, loteCodigo) : null
  ]);

  const monBase1 = String(perfil1?.moneda_base || 'USDT').trim().toUpperCase();
  const monBase2 = String(perfil2?.moneda_base || 'USDT').trim().toUpperCase();

  // 3. Determinar Naturaleza de Operación
  let tipoCalculado = item.tipo || item.tipo_op1 || item.naturaleza;
  if (!tipoCalculado || tipoCalculado === 'D') {
    if (moneda && monBase1 && moneda === monBase1) tipoCalculado = 'A';
    else if (perfil1?.monedas?.[moneda]?.tipo) tipoCalculado = perfil1.monedas[moneda].tipo;
    else if (moneda !== monBase1 && moneda !== '') tipoCalculado = 'P';
    else tipoCalculado = 'D';
  }

  // 4. Extracción de Tasas T1 y T2
  let tasa1 = 'N/A';
  if (tieneMonedaS1) {
    tasa1 = (tipoCalculado === 'A' || monBase1 === moneda) ? 1.00 : extraerTasaHub(dataHub1, moneda, tipoCalculado);
  }

  let tasa2 = 'N/A';
  if (tieneMonedaS2) {
    tasa2 = (tipoCalculado === 'A' || monBase2 === moneda) ? 1.00 : extraerTasaHub(dataHub2, moneda, tipoCalculado);
  }

  const numT1 = Number(tasa1);
  const numT2 = Number(tasa2);

  const monto1 = !isNaN(numT1) && numT1 > 0 ? Number((monto / numT1).toFixed(2)) : monto;
  const monto2 = !isNaN(numT2) && numT2 > 0 ? Number((monto / numT2).toFixed(2)) : monto;

  const tasaMeBase = Number(loteGlaukov?.tasas?.[moneda] || 1);
  const me1 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto1;
  const me2 = tasaMeBase > 0 ? Number((monto / tasaMeBase).toFixed(2)) : monto2;

  // 5. Polaridades
  const polaridad1 = obtenerPolaridadPorTipo(perfil1, moneda, tipoCalculado, true);
  const polaridad2 = obtenerPolaridadPorTipo(perfil2, moneda, tipoCalculado, false);

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
        polaridad: polaridad1,
        monto: monto1,
        moneda_base: monBase1,
        me: me1
      },
      grupo_2: {
        grupo: nombreGrupo2,
        tasa: tasa2,
        polaridad: polaridad2,
        monto: monto2,
        moneda_base: monBase2,
        me: me2
      }
    }
  };
}

module.exports = { procesarComprobante };
