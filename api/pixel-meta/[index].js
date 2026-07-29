// GET /api/pixel-meta/{index}.json
//   TEP-62-совместимая метадата для отдельной NFT из коллекции durov.dog pixels.
//   Getgems/Tonviewer читают этот URL из get_nft_content() контракта.
//   Content-Type: application/json. Кэш 5 мин / 24ч SWR.

const CONTRACT = process.env.PIXEL_CONTRACT || 'EQBoX6dWBxYGrJBU5D2IewnTnDPR8qoJVGGMLcTJH5lgiQrY';
const TONAPI = 'https://tonapi.io';
const IMAGE = 'https://durov.dog/bg.png';

async function tonapiMethod(account, method, args = []) {
  const qs = args.length ? '?' + args.map((a) => `args=${a}`).join('&') : '';
  const headers = {};
  if (process.env.TONAPI_KEY) headers.Authorization = `Bearer ${process.env.TONAPI_KEY}`;
  const r = await fetch(`${TONAPI}/v2/blockchain/accounts/${encodeURIComponent(account)}/methods/${method}${qs}`, { headers });
  if (!r.ok) throw new Error(`tonapi ${method}: ${r.status}`);
  return r.json();
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  try {
    const raw = String(req.query.index || '').replace(/\.json$/, '');
    const index = Number(raw);
    if (!Number.isInteger(index) || index < 0 || index > 1_000_000) {
      return res.status(400).json({ error: 'bad index' });
    }

    // 1) Через collection getter: get_nft_address_by_index(N) → адрес item'а
    const addrRes = await tonapiMethod(CONTRACT, 'get_nft_address_by_index', [String(index)]);
    const itemAddress = addrRes?.decoded?.address;
    if (!itemAddress) throw new Error('no item address');

    // 2) Читаем pixel_range из item'а: [start, count]
    let pixelStart = null;
    let pixelCount = null;
    try {
      const range = await tonapiMethod(itemAddress, 'pixel_range', []);
      const nums = (range.stack || []).filter((s) => s.type === 'num').map((s) => parseInt(s.num, 16));
      if (nums.length >= 2) {
        pixelStart = nums[0];
        pixelCount = nums[1];
      }
    } catch { /* item ещё не инициализирован — вернём базовую метадату */ }

    const meta = {
      name: `durov.dog pixel #${index}`,
      description: pixelCount !== null
        ? `${pixelCount} pixel${pixelCount === 1 ? '' : 's'} of the durov.dog wall (position ${pixelStart}${pixelCount > 1 ? '–' + (pixelStart + pixelCount - 1) : ''}). One of 1,000,000. Grants Premium on tonscanner.io + Telegram pack. 50% of every mint funds the Durov Dog Shelter. Manifesto at durov.dog. #ad`
        : `A pixel from the durov.dog wall. One of 1,000,000. Grants Premium on tonscanner.io + Telegram pack. 50% of every mint funds the Durov Dog Shelter. Manifesto at durov.dog. #ad`,
      image: IMAGE,
      external_url: 'https://durov.dog',
      attributes: pixelCount !== null
        ? [
            { trait_type: 'Position', value: pixelStart },
            { trait_type: 'Pixels', value: pixelCount },
            ...(pixelCount > 1 ? [{ trait_type: 'Range', value: `${pixelStart}–${pixelStart + pixelCount - 1}` }] : []),
            { trait_type: 'Row', value: Math.floor(pixelStart / 1000) + 1 },
            { trait_type: 'Column', value: (pixelStart % 1000) + 1 },
            { trait_type: 'Shelter split', value: '50%' },
          ]
        : [],
    };

    res.setHeader('Cache-Control', 'public, s-maxage=300, stale-while-revalidate=86400');
    return res.status(200).json(meta);
  } catch (e) {
    return res.status(502).json({ error: String(e?.message || e) });
  }
}
