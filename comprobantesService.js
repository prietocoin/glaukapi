const db = require('./db');

const TASASHUB_BASE_URL = process.env.TASASHUB_URL || 'https://automat-tasashub.fyi6ur.easypanel.host/api/v1/tasas/calcular';
const REMITHUB_BASE_URL = process.env.REMITHUB_URL || 'https://automat-remithub.fyi6ur.easypanel.host/api/comprobantes';

async function obtenerPerfilSocio(nombreSocio) {
  if (!nombreSocio || nombreSocio === 'GENERAL' || nombreSocio === 'NO DEFINIDO') return null;
  try {
    const { rows } = await db.query(
      'SELECT nombre, id_grupo, moneda_base, monedas FROM perfiles_glaukov WHERE UPPER(TRIM(nombre)) = UPPER(TRIM($1)) LIMIT 1',
      [nombreSocio]
    );
    if (!rows[0]) return null;
    const perfil = rows[0];
    if (typeof perfil.monedas === 'string') {
      try { perfil.monedas = JSON.parse(perfil.monedas); } catch (e) { perfil.monedas = {}; }
    }
    return perfil;
  } catch (err) {
    return null;
  }
}

async function obtenerLoteTasasGlaukov(idLote) {
  if (!idLote) return null;
  try {
    const { rows } = await db.query(
      'SELECT id_tasa, tasas, fecha FROM tasas_glaukov WHERE UPPER(TRIM(id_tasa)) = UPPER(TRIM($1)) LIMIT 1',
      [idLote]
    );
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

async function consultarTasasHub(socio, lote) {
  if (!socio || socio === 'GENERAL' || socio === 'NO DEFINIDO') return null;
  try {
    const socioQuery = encodeURIComponent(String(socio).trim());
    const loteQuery = lote ? `?lote=${encodeURIComponent(String(lote).trim())}` : '';
    const res = await fetch(`${TASASHUB_BASE_URL}/${socioQuery}${loteQuery}`);
    return res.ok ? await res.json() : null;
  } catch (err) {
    return null;
  }
}

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

async function procesarComprobante(item) {
  const lote = String(item.lote_tasa || item.lote_tasa_asignado || item.id_tasa || 'T001').trim();
  const monto = Math.abs(Number(item.monto || item.monto_local || 0));
  const moneda = String(item.moneda || item.moneda_local || '').trim().toUpperCase();

  const rawS1 = item.grupo_raw_1 || item.nombre_socio_1 || item.socio_1 || 'GENERAL';
  const rawS2 = item.grupo_raw_2 || item.nombre_socio_2 || item.socio_2 || 'GENERAL';

  const [perfil1, perfil2, loteGlaukov, dataHub1, dataHub2] = await Promise.all([
    obtenerPerfilSocio(rawS1),
    obtenerPerfilSocio(rawS2),
    obtenerLoteTasasGlaukov(lote),
    consultarTasasHub(rawS1, lote),
    consultarTasasHub(rawS2, lote)
  ]);

  const nombreS1 = perfil1?.nombre || rawS1;
  const nombreS2 = perfil2?.nombre || rawS2;

  const monBase1 = String(perfil1?.moneda_base || item.moneda_base_socio1 || 'USDT').trim().toUpperCase();
  const monBase2 = String(perfil2?.moneda_base || item.moneda_base_socio2 || 'USDT').trim().toUpperCase();

  let tipoCalculado = item.tipo || item.tipo_op1 || item.naturaleza;
  if (!tipoCalculado || tipoCalculado === 'D') {
    if (moneda && monBase1 && moneda === monBase1) tipoCalculado = 'A';
    else if (perfil1?.monedas?.[moneda]?.tipo) tipoCalculado = perfil1.monedas[moneda].tipo;
    else if (moneda !== monBase1 && moneda !== '') tipoCalculado = 'P';
    else tipoCalculado = 'D';
  }

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
        nombre_1: nombreS1,
        tasa_1: tasa1,
        polaridad_1: perfil1?.monedas?.[moneda]?.polaridad || '+',
        monto_1: monto1,
        moneda_base_1: monBase1,
        me_1: me1
      },
      grupo_2: {
        nombre_2: nombreS2,
        tasa_2: tasa2,
        polaridad_2: perfil2?.monedas?.[moneda]?.polaridad || '+',
        monto_2: monto2,
        moneda_base_2: monBase2,
        me_2: me2
      }
    }
  };
}

module.exports = { procesarComprobante };
