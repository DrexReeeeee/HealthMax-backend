/**
 * alternativeService.js
 *
 * Finds healthier alternatives using:
 *   1. Open Food Facts (primary, v1 → v2 fallback with progressive category broadening)
 *   2. USDA FoodData Central (secondary, used when OFF returns < 3 results)
 *   3. Local Supabase cache (tertiary fallback)
 *
 * NOVA-aware: alternatives are ONLY returned if they are genuinely better —
 * i.e. higher score under our scoring model (which already penalises NOVA 4 heavily).
 * An alternative with NOVA 4 will almost never beat the current product unless
 * the current product is also ultra-processed but with worse nutrients.
 */

const supabase = require('../config/supabase');
const { calculateScore, normalizeNutrients } = require('./scoringService');

const OFF_BASE      = 'https://world.openfoodfacts.org';
const OFF_SEARCH    = `${OFF_BASE}/cgi/search.pl`;
const OFF_SEARCH_V2 = `${OFF_BASE}/api/v2/search`;

// USDA FoodData Central
const USDA_BASE    = 'https://api.nal.usda.gov/fdc/v1';
const USDA_API_KEY = process.env.USDA_API_KEY;

// ─── Category helpers ─────────────────────────────────────────────────────────

function normalizeCategory(category) {
  if (!category) return 'general';
  return category.startsWith('en:') ? category.slice(3) : category;
}

function buildSearchTags(category) {
  const stripped = normalizeCategory(category);
  const parts    = stripped.split('-');
  const tags     = [stripped];

  for (let i = parts.length - 1; i >= 1; i--) {
    const tag = parts.slice(i).join('-');
    if (!tags.includes(tag)) tags.push(tag);
  }

  // Always include broad fallbacks
  if (!tags.includes('snacks')) tags.push('snacks');
  tags.push('food');

  return tags;
}

// ─── Open Food Facts ──────────────────────────────────────────────────────────

async function searchOFFByCategory(category, pageSize = 30) {
  const tags = buildSearchTags(category);
  console.log(`[alternativeService] OFF search tags:`, tags);

  for (const tag of tags) {
    // Try v1
    try {
      const params = new URLSearchParams({
        action: 'process', tagtype_0: 'categories',
        tag_contains_0: 'contains', tag_0: tag,
        fields: [
          'code', 'product_name', 'brands', 'image_front_url',
          'nutriments', 'nova_group', 'additives_tags',
          'categories_tags', 'nutriscore_grade',
        ].join(','),
        json: '1', page_size: String(pageSize), page: '1',
        sort_by: 'unique_scans_n',
      });

      const res = await fetch(`${OFF_SEARCH}?${params}`, {
        headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data     = await res.json();
        const products = data.products || [];
        console.log(`[alternativeService] OFF v1 "${tag}": ${products.length} results`);
        if (products.length >= 5) return products;
      }
    } catch (err) {
      console.warn(`[alternativeService] OFF v1 "${tag}" failed:`, err.message);
    }

    // Try v2
    try {
      const params = new URLSearchParams({
        categories_tags: tag,
        fields: [
          'code', 'product_name', 'brands', 'image_front_url',
          'nutriments', 'nova_group', 'additives_tags',
          'categories_tags', 'nutriscore_grade',
        ].join(','),
        page_size: String(pageSize), page: '1', sort_by: 'unique_scans_n',
      });

      const res = await fetch(`${OFF_SEARCH_V2}?${params}`, {
        headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data     = await res.json();
        const products = data.products || [];
        console.log(`[alternativeService] OFF v2 "${tag}": ${products.length} results`);
        if (products.length >= 5) return products;
      }
    } catch (err) {
      console.warn(`[alternativeService] OFF v2 "${tag}" failed:`, err.message);
    }
  }

  return [];
}

async function fetchOFFProduct(barcode) {
  try {
    const res = await fetch(`${OFF_BASE}/api/v2/product/${barcode}.json`, {
      headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.status === 1 ? data.product : null;
  } catch (err) {
    console.error('[alternativeService] OFF fetch failed:', err.message);
    return null;
  }
}

function extractOFFNutriments(product) {
  const n = product.nutriments || {};
  return {
    energy_kcal_100g:     n['energy-kcal_100g'] ?? n.energy_kcal ?? null,
    energy_100g:          n.energy_100g          ?? null,
    sugars_100g:          n.sugars_100g           ?? null,
    'saturated-fat_100g': n['saturated-fat_100g'] ?? null,
    sodium_100g:          n.sodium_100g            ?? null,
    salt_100g:            n.salt_100g              ?? null,
    fiber_100g:           n.fiber_100g             ?? null,
    proteins_100g:        n.proteins_100g          ?? null,
    nova_group:           product.nova_group        ?? null,
    additives_tags:       product.additives_tags     ?? [],
  };
}

function hasSufficientOFFData(product) {
  const n = product.nutriments || {};
  return (
    (n['energy-kcal_100g'] != null || n.energy_100g != null) &&
    n.sugars_100g != null &&
    (n.salt_100g != null || n.sodium_100g != null)
  );
}

// ─── OFF image lookup for USDA products ──────────────────────────────────────

/**
 * Searches Open Food Facts by product name + brand to find an image.
 * Used to enrich USDA results which have no images of their own.
 * Returns image URL string or null — never throws.
 */
async function fetchOFFImageForProduct(name, brand) {
  try {
    // Build a focused query: brand + first 3 words of name
    const namePart  = name.split(' ').slice(0, 3).join(' ');
    const query     = brand ? `${brand} ${namePart}` : namePart;

    const params = new URLSearchParams({
      action:   'process',
      search_terms: query,
      fields:   'code,product_name,brands,image_front_url',
      json:     '1',
      page_size: '5',
      page:      '1',
    });

    const res = await fetch(`${OFF_SEARCH}?${params}`, {
      headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
      signal:  AbortSignal.timeout(4000),
    });

    if (!res.ok) return null;

    const data     = await res.json();
    const products = data.products || [];

    // Pick the first result that has an image
    const match = products.find(p => p.image_front_url);
    return match?.image_front_url ?? null;
  } catch {
    return null;
  }
}


// ─── USDA FoodData Central ────────────────────────────────────────────────────

/**
 * Search USDA for branded foods matching a simplified category keyword.
 * Returns nutrients normalized to our internal format.
 * 
 * FIX 1: API key now sent as query parameter (not in POST body)
 */
async function searchUSDA(category, pageSize = 20) {
  if (!USDA_API_KEY) {
    console.warn('[alternativeService] USDA_API_KEY not set — skipping USDA search');
    return [];
  }

  // Simplify category for USDA keyword search
  const keyword = normalizeCategory(category)
    .split('-')
    .slice(0, 2)        // use first 2 words max
    .join(' ');

  console.log(`[alternativeService] USDA search keyword: "${keyword}"`);

  try {
    // FIX 1: API key as query parameter, not in body
    const url = `${USDA_BASE}/foods/search?api_key=${encodeURIComponent(USDA_API_KEY)}`;
    
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query:      keyword,
        dataType:   ['Branded'],
        pageSize,
        sortBy:     'dataType.keyword',
        sortOrder:  'asc',
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!res.ok) {
      console.warn(`[alternativeService] USDA returned ${res.status}: ${res.statusText}`);
      return [];
    }

    const data  = await res.json();
    const foods = data.foods || [];
    console.log(`[alternativeService] USDA returned ${foods.length} foods`);

    return foods
      .map(food => {
        // Map USDA nutrient IDs to our keys
        const getNutrient = (id) =>
          food.foodNutrients?.find(fn => fn.nutrientId === id)?.value ?? null;

        // USDA nutrient IDs:
        // 1008 = Energy (kcal), 2000 = Sugars total, 1258 = Saturated fat,
        // 1093 = Sodium (mg), 1079 = Fiber, 1003 = Protein
        const energy_kcal = getNutrient(1008);
        const sugar       = getNutrient(2000);
        const sat_fat     = getNutrient(1258);
        const sodium_mg   = getNutrient(1093);
        const fiber       = getNutrient(1079);
        const protein     = getNutrient(1003);

        // Skip if no usable nutrient data
        if (energy_kcal == null && sugar == null) return null;

        // Convert to our raw format (normalizeNutrients expects these keys)
        return {
          _usda: true,
          code:             String(food.fdcId),
          product_name:     food.description || 'Unknown',
          brands:           food.brandOwner  || '',
          image_front_url:  null,   // USDA has no product images
          nova_group:       null,   // USDA doesn't classify NOVA
          additives_tags:   [],
          // Pre-normalized values stored in a sub-object for extraction
          _nutrients: {
            energy_kcal_100g:     energy_kcal,
            sugars_100g:          sugar,
            'saturated-fat_100g': sat_fat,
            // USDA gives sodium in mg per 100g already
            sodium_100g:          sodium_mg != null ? sodium_mg / 1000 : null, // mg → g for our normalizer
            fiber_100g:           fiber,
            proteins_100g:        protein,
            nova_group:           null,
            additives_tags:       [],
          },
        };
      })
      .filter(Boolean);
  } catch (err) {
    console.error('[alternativeService] USDA search failed:', err.message);
    return [];
  }
}

// ─── Comparison explanation ───────────────────────────────────────────────────

function buildComparisonReason(currentNorm, altNorm, currentScore, altScore) {
  const reasons = [];

  if (currentNorm.sugar != null && altNorm.sugar != null) {
    const diff = currentNorm.sugar - altNorm.sugar;
    if (diff > 2) reasons.push(`${diff.toFixed(1)}g less sugar`);
  }

  if (currentNorm.sodium != null && altNorm.sodium != null) {
    const diff = currentNorm.sodium - altNorm.sodium;
    if (diff > 50) reasons.push(`${Math.round(diff)}mg less sodium`);
  }

  if (currentNorm.saturated_fat != null && altNorm.saturated_fat != null) {
    const diff = currentNorm.saturated_fat - altNorm.saturated_fat;
    if (diff > 0.5) reasons.push(`${diff.toFixed(1)}g less saturated fat`);
  }

  if (altNorm.fiber != null && currentNorm.fiber != null) {
    const diff = altNorm.fiber - currentNorm.fiber;
    if (diff > 0.5) reasons.push(`${diff.toFixed(1)}g more fiber`);
  }

  if (altNorm.protein != null && currentNorm.protein != null) {
    const diff = altNorm.protein - currentNorm.protein;
    if (diff > 1) reasons.push(`${diff.toFixed(1)}g more protein`);
  }

  // NOVA improvement is a strong positive signal
  if (altNorm.nova_group != null && currentNorm.nova_group != null
      && altNorm.nova_group < currentNorm.nova_group) {
    reasons.push(`less processed (NOVA ${altNorm.nova_group} vs ${currentNorm.nova_group})`);
  } else if (currentNorm.nova_group === 4 && altNorm.nova_group == null) {
    // USDA product with unknown NOVA but good nutrients — still worth suggesting
    reasons.push('potentially less processed');
  }

  if (reasons.length === 0)
    reasons.push(`overall healthier profile (+${altScore - currentScore} pts)`);

  return `Better because: ${reasons.join(', ')}.`;
}

// ─── Grade from score ─────────────────────────────────────────────────────────

function scoreToGrade(score) {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  if (score >= 25) return 'D';
  return 'E';
}

// ─── Main: getAlternatives ────────────────────────────────────────────────────

async function getAlternatives({
  category,
  currentScore,
  currentBarcode,
  currentNutrients = {},
  modifiers        = {},
  userContext      = {},
}) {
  const currentNorm = normalizeNutrients(currentNutrients);

  // ── Step 1: Open Food Facts ───────────────────────────────────────────────
  const offProducts = await searchOFFByCategory(category);

  const offScored = offProducts
    .filter(p => p.code && p.code !== currentBarcode && hasSufficientOFFData(p))
    .map(p => {
      const raw              = extractOFFNutriments(p);
      const { score, grade } = calculateScore(raw, modifiers, userContext);
      const norm             = normalizeNutrients(raw);
      return {
        barcode:   p.code,
        name:      p.product_name || 'Unknown product',
        brand:     p.brands || '',
        score,
        grade,
        image_url: p.image_front_url || null,
        reason:    buildComparisonReason(currentNorm, norm, currentScore, score),
        source:    'open_food_facts',
        nova_group: norm.nova_group,
      };
    })
    .filter(p => p.score > currentScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  console.log(`[alternativeService] OFF scored ${offScored.length} better alternatives`);

  if (offScored.length >= 3) {
    upsertToLocalCache(offScored).catch(err =>
      console.warn('[alternativeService] Cache upsert failed:', err.message)
    );
    return offScored;
  }

  // ── Step 2: USDA fallback ─────────────────────────────────────────────────
  console.log('[alternativeService] Trying USDA fallback...');
  const usdaProducts = await searchUSDA(category);

  // Score USDA products
  const usdaScored = usdaProducts
    .filter(p => p.code !== currentBarcode)
    .map(p => {
      const raw              = p._nutrients;
      const { score, grade } = calculateScore(raw, modifiers, userContext);
      const norm             = normalizeNutrients(raw);
      return {
        barcode:    p.code,
        name:       p.product_name,
        brand:      p.brands,
        score,
        grade,
        image_url:  null,   // will be filled asynchronously below
        reason:     buildComparisonReason(currentNorm, norm, currentScore, score),
        source:     'usda',
        nova_group: null,
      };
    })
    .filter(p => p.score > currentScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3 - offScored.length);

  // FIX 3: Fire-and-forget image enrichment — don't block the response
  // Kick off image lookups in the background
  usdaScored.forEach(p => {
    fetchOFFImageForProduct(p.name, p.brand)
      .then(image_url => {
        if (image_url) p.image_url = image_url;
      })
      .catch(() => {});  // silently ignore failures
  });

  console.log(`[alternativeService] USDA scored ${usdaScored.length} better alternatives (images loading in background)`);

  const combined = [...offScored, ...usdaScored];
  if (combined.length >= 3) return combined.slice(0, 3);

  // ── Step 3: Local Supabase cache ──────────────────────────────────────────
  console.log('[alternativeService] Supplementing from local DB...');

  const categoryStripped = normalizeCategory(category);
  const { data: dbResults } = await supabase
    .from('products')
    .select('barcode, name, brand, base_score, image_url, nutrients, category')
    .or(`category.eq.${category},category.ilike.%${categoryStripped}%`)
    .neq('barcode', currentBarcode)
    .not('nutrients', 'is', null)
    .order('base_score', { ascending: false })
    .limit(10);

  const dbScored = (dbResults ?? [])
    .map(p => {
      if (!p.nutrients) return null;
      const { score, grade } = calculateScore(p.nutrients, modifiers, userContext);
      const norm             = normalizeNutrients(p.nutrients);
      return {
        barcode:   p.barcode,
        name:      p.name,
        brand:     p.brand || '',
        score,
        grade,
        image_url: p.image_url,
        reason:    buildComparisonReason(currentNorm, norm, currentScore, score),
        source:    'local_cache',
      };
    })
    .filter(p => p !== null && p.score > currentScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3 - combined.length);

  console.log(`[alternativeService] DB scored ${dbScored.length} better alternatives`);

  return [...combined, ...dbScored].slice(0, 3);
}

// ─── Cache upsert ─────────────────────────────────────────────────────────────

async function upsertToLocalCache(products) {
  const rows = products
    .filter(p => p.source === 'open_food_facts')  // only cache OFF products (have barcodes)
    .map(p => ({
      barcode:    p.barcode,
      name:       p.name,
      brand:      p.brand,
      base_score: p.score,
      image_url:  p.image_url,
      updated_at: new Date().toISOString(),
    }));

  if (rows.length === 0) return;

  await supabase
    .from('products')
    .upsert(rows, { onConflict: 'barcode', ignoreDuplicates: false });
}

// ─── Score a barcode on-demand ────────────────────────────────────────────────

async function scoreProductByBarcode(barcode, modifiers = {}, userContext = {}) {
  const product = await fetchOFFProduct(barcode);
  if (!product) return null;

  const raw                         = extractOFFNutriments(product);
  const { score, grade, breakdown } = calculateScore(raw, modifiers, userContext);

  return {
    barcode,
    name:      product.product_name,
    brand:     product.brands,
    score,
    grade,
    breakdown,
    image_url: product.image_front_url,
  };
}

module.exports = { getAlternatives, scoreProductByBarcode, fetchOFFProduct };