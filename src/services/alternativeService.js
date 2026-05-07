const supabase = require('../config/supabase');
const { calculateScore, normalizeNutrients } = require('./scoringService');

const OFF_BASE     = 'https://world.openfoodfacts.org';
const OFF_SEARCH   = `${OFF_BASE}/cgi/search.pl`;
const OFF_SEARCH_V2 = `${OFF_BASE}/api/v2/search`;

// ─── Strip "en:" prefix for OFF search ───────────────────────────────────────

function normalizeCategory(category) {
  if (!category) return 'general';
  return category.startsWith('en:') ? category.slice(3) : category;
}

// ─── Open Food Facts helpers ──────────────────────────────────────────────────

async function searchOFFByCategory(category, pageSize = 24) {
  const stripped = normalizeCategory(category);
  const parts    = stripped.split('-');

  // Build progressively broader tags from most specific to broadest
  // e.g. "snacks-savory-snacks-seafood-snacks-fish-crackers" →
  //   ["snacks-savory-snacks-seafood-snacks-fish-crackers",
  //    "snacks-fish-crackers", "fish-crackers", "crackers", "snacks", "food"]
  const searchTags = [];
  searchTags.push(stripped);

  for (let i = parts.length - 1; i >= 1; i--) {
    const tag = parts.slice(i).join('-');
    if (!searchTags.includes(tag)) searchTags.push(tag);
  }

  if (!searchTags.includes('snacks')) searchTags.push('snacks');
  searchTags.push('food');

  console.log(`[alternativeService] Will try these tags in order:`, searchTags);

  for (const searchTag of searchTags) {
    // ── Try v1 first ────────────────────────────────────────────────
    try {
      const params = new URLSearchParams({
        action:         'process',
        tagtype_0:      'categories',
        tag_contains_0: 'contains',
        tag_0:          searchTag,
        fields: [
          'code', 'product_name', 'brands', 'image_front_url',
          'nutriments', 'nova_group', 'additives_tags', 'categories_tags',
          'nutriscore_grade',
        ].join(','),
        json:      '1',
        page_size: String(pageSize),
        page:      '1',
        sort_by:   'unique_scans_n',
      });

      console.log(`[alternativeService] Trying OFF v1 category: "${searchTag}"`);

      const res = await fetch(`${OFF_SEARCH}?${params}`, {
        headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
        signal:  AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.warn(`[alternativeService] OFF v1 returned ${res.status} for "${searchTag}", trying v2...`);
        throw new Error(`v1 failed with ${res.status}`);
      }

      const data     = await res.json();
      const products = data.products || [];
      console.log(`[alternativeService] OFF v1 returned ${products.length} products for "${searchTag}"`);

      // Need at least 5 candidates to have a chance of finding better ones
      if (products.length >= 5) return products;
    } catch (err) {
      console.warn(`[alternativeService] OFF v1 failed for "${searchTag}":`, err.message);
    }

    // ── Fallback: Try v2 ─────────────────────────────────────────────
    try {
      const params = new URLSearchParams({
        categories_tags: searchTag,
        fields: [
          'code', 'product_name', 'brands', 'image_front_url',
          'nutriments', 'nova_group', 'additives_tags', 'categories_tags',
          'nutriscore_grade',
        ].join(','),
        page_size: String(pageSize),
        page:      '1',
        sort_by:   'unique_scans_n',
      });

      console.log(`[alternativeService] Trying OFF v2 category: "${searchTag}"`);

      const res = await fetch(`${OFF_SEARCH_V2}?${params}`, {
        headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
        signal:  AbortSignal.timeout(8000),
      });

      if (!res.ok) {
        console.warn(`[alternativeService] OFF v2 returned ${res.status} for "${searchTag}"`);
        continue;
      }

      const data     = await res.json();
      const products = data.products || [];
      console.log(`[alternativeService] OFF v2 returned ${products.length} products for "${searchTag}"`);

      if (products.length >= 5) return products;
    } catch (err) {
      console.error(`[alternativeService] OFF v2 failed for "${searchTag}":`, err.message);
    }
  }

  return [];
}

async function fetchOFFProduct(barcode) {
  try {
    const res = await fetch(`${OFF_BASE}/api/v2/product/${barcode}.json`, {
      headers: { 'User-Agent': 'HealthMax App - healthmax@example.com' },
      signal:  AbortSignal.timeout(6000),
    });
    if (!res.ok) return null;
    const data = await res.json();
    return data.status === 1 ? data.product : null;
  } catch (err) {
    console.error('[alternativeService] OFF fetch failed:', err.message);
    return null;
  }
}

// ─── Nutriment extractor ──────────────────────────────────────────────────────

function extractNutriments(product) {
  const n = product.nutriments || {};
  return {
    energy_kcal_100g:     n['energy-kcal_100g'] ?? n.energy_kcal ?? null,
    energy_100g:          n.energy_100g ?? null,
    sugars_100g:          n.sugars_100g ?? null,
    'saturated-fat_100g': n['saturated-fat_100g'] ?? null,
    sodium_100g:          n.sodium_100g ?? null,
    salt_100g:            n.salt_100g ?? null,
    fiber_100g:           n.fiber_100g ?? null,
    proteins_100g:        n.proteins_100g ?? null,
    nova_group:           product.nova_group ?? null,
    additives_tags:       product.additives_tags ?? [],
  };
}

function hasSufficientData(product) {
  const n = product.nutriments || {};
  const hasEnergy = n['energy-kcal_100g'] != null || n.energy_100g != null;
  const hasSugar  = n.sugars_100g != null;
  const hasSalt   = n.salt_100g != null || n.sodium_100g != null;
  return hasEnergy && hasSugar && hasSalt;
}

// ─── Grade from score ─────────────────────────────────────────────────────────

function scoreToGrade(score) {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  if (score >= 25) return 'D';
  return 'E';
}

// ─── Comparison explanation ───────────────────────────────────────────────────

function buildComparisonReason(currentNorm, altNorm, currentScore, altScore) {
  const reasons = [];

  const sugarDiff = currentNorm.sugar - altNorm.sugar;
  if (sugarDiff > 2) reasons.push(`${sugarDiff.toFixed(1)}g less sugar per 100g`);

  const sodiumDiff = currentNorm.sodium - altNorm.sodium;
  if (sodiumDiff > 50) reasons.push(`${Math.round(sodiumDiff)}mg less sodium`);

  const fatDiff = currentNorm.saturated_fat - altNorm.saturated_fat;
  if (fatDiff > 0.5) reasons.push(`${fatDiff.toFixed(1)}g less saturated fat`);

  const fiberDiff = altNorm.fiber - currentNorm.fiber;
  if (fiberDiff > 0.5) reasons.push(`${fiberDiff.toFixed(1)}g more fiber`);

  const proteinDiff = altNorm.protein - currentNorm.protein;
  if (proteinDiff > 1) reasons.push(`${proteinDiff.toFixed(1)}g more protein`);

  if (altNorm.nova_group && currentNorm.nova_group && altNorm.nova_group < currentNorm.nova_group)
    reasons.push('less processed');

  if (reasons.length === 0)
    reasons.push(`overall healthier profile (+${altScore - currentScore} pts)`);

  return `Better because: ${reasons.join(', ')}.`;
}

// ─── Main export ──────────────────────────────────────────────────────────────

async function getAlternatives({
  category,
  currentScore,
  currentBarcode,
  currentNutrients = {},
  modifiers = {},
  userContext = {},
}) {
  const currentNorm = normalizeNutrients(currentNutrients);

  // ── Step 1: Try Open Food Facts (v1 then v2 fallback) ────────────────────
  const offProducts = await searchOFFByCategory(category);

  const scored = offProducts
    .filter(p => p.code && p.code !== currentBarcode && hasSufficientData(p))
    .map(p => {
      const raw              = extractNutriments(p);
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
      };
    })
    .filter(p => p.score > currentScore)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  console.log(`[alternativeService] Found ${scored.length} alternatives from OFF`);

  if (scored.length >= 3) {
    upsertToLocalCache(scored).catch(err =>
      console.warn('[alternativeService] Cache upsert failed:', err.message)
    );
    return scored;
  }

  // ── Step 2: Supplement from local Supabase cache ──────────────────────────
  console.log('[alternativeService] Supplementing from DB...');

  const categoryExact    = category;
  const categoryStripped = normalizeCategory(category);

  const { data: dbResults, error } = await supabase
    .from('products')
    .select('barcode, name, brand, base_score, image_url, nutrients, category')
    .or(`category.eq.${categoryExact},category.ilike.%${categoryStripped}%`)
    .neq('barcode', currentBarcode)
    .not('nutrients', 'is', null)
    .order('base_score', { ascending: false })
    .limit(10);

  if (!error && dbResults?.length) {
    const dbScored = dbResults
      .map(p => {
        const norm = p.nutrients ? normalizeNutrients(p.nutrients) : null;
        if (!norm) return null;

        const { score, grade } = calculateScore(p.nutrients, modifiers, userContext);
        const reason           = buildComparisonReason(currentNorm, norm, currentScore, score);

        return {
          barcode:   p.barcode,
          name:      p.name,
          brand:     p.brand || '',
          score,
          grade,
          image_url: p.image_url,
          reason,
          source:    'local_cache',
        };
      })
      .filter(p => p !== null && p.score > currentScore)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3 - scored.length);

    console.log(`[alternativeService] Got ${dbScored.length} alternatives from DB`);
    return [...scored, ...dbScored].slice(0, 3);
  }

  console.log('[alternativeService] No alternatives found anywhere');
  return scored;
}

// ─── Cache helper ─────────────────────────────────────────────────────────────

async function upsertToLocalCache(products) {
  const rows = products.map(p => ({
    barcode:    p.barcode,
    name:       p.name,
    brand:      p.brand,
    base_score: p.score,
    image_url:  p.image_url,
    updated_at: new Date().toISOString(),
  }));

  await supabase
    .from('products')
    .upsert(rows, { onConflict: 'barcode', ignoreDuplicates: false });
}

// ─── Convenience: score a barcode on-demand via OFF ──────────────────────────

async function scoreProductByBarcode(barcode, modifiers = {}, userContext = {}) {
  const product = await fetchOFFProduct(barcode);
  if (!product) return null;

  const raw                         = extractNutriments(product);
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