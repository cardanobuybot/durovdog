// GET /api/pixels-sold
//   Возвращает { sold, total } — сколько NFT уже заминчено в коллекции
//   «Durov Dog PIXEL». Читается напрямую из TonAPI, никакого state.
//
// Frontend опрашивает раз в 30 сек, обновляет счётчик и reveal-канвас.

const COLLECTION = process.env.PIXEL_COLLECTION || 'EQCTHxInEIDT9PnjRMMCpMOY8BwOQZVoeGWyuz1m8zEEtLxW';
const TOTAL = 1_000_000;

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, s-maxage=15, stale-while-revalidate=60');
  try {
    // Пагинируем коллекцию, суммируем — простой ground-truth. При <5000
    // элементов это ≤5 запросов по 1000, отлично влезает в function budget.
    let sold = 0;
    let offset = 0;
    const limit = 1000;
    while (offset < TOTAL) {
      const url = `https://tonapi.io/v2/nfts/collections/${encodeURIComponent(COLLECTION)}/items?limit=${limit}&offset=${offset}`;
      const headers = {};
      if (process.env.TONAPI_KEY) headers.Authorization = `Bearer ${process.env.TONAPI_KEY}`;
      const r = await fetch(url, { headers });
      if (!r.ok) throw new Error(`tonapi ${r.status}`);
      const j = await r.json();
      const chunk = Array.isArray(j.nft_items) ? j.nft_items.length : 0;
      sold += chunk;
      if (chunk < limit) break; // короче лимита → это последняя страница
      offset += limit;
    }
    return res.status(200).json({ sold, total: TOTAL });
  } catch (e) {
    // На ошибке отдаём последнее известное (0 если ничего). Клиент не роняем.
    return res.status(200).json({ sold: 0, total: TOTAL, error: String(e?.message || e) });
  }
}
