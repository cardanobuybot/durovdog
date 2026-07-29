// GET /api/pixels-sold
//   Читает getter `pixels_sold` смарт-контракта коллекции. Один HTTP-запрос,
//   ground-truth из блокчейна, ~15 сек CDN-кэш.

const CONTRACT = process.env.PIXEL_CONTRACT || 'EQBoX6dWBxYGrJBU5D2IewnTnDPR8qoJVGGMLcTJH5lgiQrY';
const TOTAL = 1_000_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
  try {
    const url = `https://tonapi.io/v2/blockchain/accounts/${encodeURIComponent(CONTRACT)}/methods/pixels_sold`;
    const headers = {};
    if (process.env.TONAPI_KEY) headers.Authorization = `Bearer ${process.env.TONAPI_KEY}`;
    const r = await fetch(url, { headers });
    if (!r.ok) throw new Error(`tonapi ${r.status}`);
    const j = await r.json();
    const num = (j.stack || []).find((s) => s.type === 'num');
    const sold = num ? parseInt(num.num, 16) : 0;
    return res.status(200).json({ sold, total: TOTAL });
  } catch (e) {
    return res.status(200).json({ sold: 0, total: TOTAL, error: String(e?.message || e) });
  }
}
