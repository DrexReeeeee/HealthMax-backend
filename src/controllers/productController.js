const axios = require('axios');
const supabase = require('../config/supabase');
const { calculateScore, generateWarnings, generateDescription, getScoreColor, normalizeNutrients } = require('../services/scoringService');
const { getAlternatives } = require('../services/alternativeService');
const { buildModifiers } = require('../services/personalizationService');

const OFF_BASE_URL = 'https://world.openfoodfacts.org/api/v0/product';

// ─── OFF fetch ────────────────────────────────────────────────────────────────

async function fetchFromOFF(barcode) {
  try {
    const url = `${OFF_BASE_URL}/${barcode}.json`;
    console.log(`[OFF] Fetching: ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: { 'User-Agent': 'FitMax/1.0 (fitmax@gmail.com)' },
    });

    const data = response.data;
    if (!data || data.status === 0 || !data.product) {
      console.log(`[OFF] Product not found: ${barcode}`);
      return null;
    }

    const p = data.product;
    const n = p.nutriments || {};

    // ── FIX: capture ALL key variants OFF uses ────────────────────────
    // OFF is inconsistent — some products store values under `sugars_100g`,
    // others under plain `sugars`. We capture every variant here so
    // normalizeNutrients() never silently falls back to 0 when the data
    // actually exists under a different key name.
    const rawNutrients = {
      // Energy: prefer kcal key, keep kJ as fallback (normalizeNutrients divides by 4.184)
      energy_kcal_100g:
        n['energy-kcal_100g'] ??
        n['energy-kcal']      ??
        null,
      energy_100g:
        n['energy_100g'] ??
        n['energy']      ??
        null,

      // Sugar — OFF uses both 'sugars_100g' and plain 'sugars'
      sugars_100g:
        n['sugars_100g'] ??
        n['sugars']      ??
        null,

      // Saturated fat — note the hyphen in the OFF key name
      'saturated-fat_100g':
        n['saturated-fat_100g'] ??
        n['saturated-fat']      ??
        null,

      // Salt
      salt_100g:
        n['salt_100g'] ??
        n['salt']      ??
        null,

      // Sodium — OFF gives this in grams; normalizeNutrients converts to mg
      sodium_100g:
        n['sodium_100g'] ??
        n['sodium']      ??
        null,

      // Fiber — OFF uses both 'fiber' and 'fibers' variants
      fiber_100g:
        n['fiber_100g']  ??
        n['fiber']       ??
        n['fibers_100g'] ??
        n['fibers']      ??
        null,

      // Proteins
      proteins_100g:
        n['proteins_100g'] ??
        n['proteins']      ??
        n['protein_100g']  ??
        n['protein']       ??
        null,

      nova_group:     p.nova_group     ?? null,
      additives_tags: p.additives_tags ?? [],
    };

    // Log resolved nutriments so future products are easy to debug
    console.log(`[OFF] Raw nutriments for ${barcode}:`, JSON.stringify(rawNutrients));

    // Category: last English tag = most specific
    let category = 'general';
    if (p.categories_tags?.length) {
      const enTags = p.categories_tags.filter(c => c.startsWith('en:'));
      if (enTags.length) category = enTags[enTags.length - 1];
    }

    return {
      barcode,
      name:       p.product_name_en || p.product_name || 'Unknown Product',
      brand:      p.brands || 'Unknown Brand',
      category,
      image_url:  p.image_front_url || p.image_url || null,
      nutriscore: p.nutriscore_grade?.toUpperCase() ?? null,
      rawNutrients,
    };
  } catch (err) {
    console.error('[OFF] Error:', err.code === 'ECONNABORTED' ? 'Timeout' : err.message);
    return null;
  }
}

// ─── Controller ───────────────────────────────────────────────────────────────

async function getProduct(req, res) {
  try {
    const { barcode } = req.params;
    const userId = req.user?.id;

    if (!/^\d{8,14}$/.test(barcode)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid barcode format. Must be 8–14 digits.',
      });
    }

    // ── STEP 1: Check Supabase cache ──────────────────────────────────
    let { data: cached } = await supabase
      .from('products')
      .select('*')
      .eq('barcode', barcode)
      .single();

    let offProduct = null;
    let rawNutrients = {};

    if (cached) {
      console.log(`[Cache HIT] ${barcode}`);
      rawNutrients = cached.nutrients ?? {};
    } else {
      console.log(`[Cache MISS] ${barcode} — calling Open Food Facts`);
      offProduct = await fetchFromOFF(barcode);

      if (!offProduct) {
        return res.status(404).json({
          success: false,
          message: 'Product not found. Try scanning another barcode or add it manually.',
        });
      }

      rawNutrients = offProduct.rawNutrients;
    }

    // ── STEP 3: User personalization ──────────────────────────────────
    let modifiers = {};
    let userContext = {};

    if (userId) {
      const { data: profile } = await supabase
        .from('UserProfiles')
        .select('sugar_modifier, salt_modifier, fat_modifier, health_goal, dietary_preference')
        .eq('user_id', userId)
        .single();

      if (profile) {
        modifiers = buildModifiers(profile);
        userContext = {
          health_goal:        profile.health_goal,
          dietary_preference: profile.dietary_preference,
        };
        console.log(`[Personalization] user=${userId} goal=${userContext.health_goal}`);
      }
    }

    // ── STEP 4: Score ─────────────────────────────────────────────────
    const { score, grade, breakdown } = calculateScore(rawNutrients, modifiers, userContext);
    const { warnings, tips }          = generateWarnings(rawNutrients, modifiers, userContext);
    const description                  = generateDescription(score, breakdown, userContext);
    const color                        = getScoreColor(score);

    // Normalize BEFORE the upsert so norm is available for dedicated columns
    const norm = normalizeNutrients(rawNutrients);

    const productData = cached ?? offProduct;
    const category    = productData.category ?? 'general';

    // ── STEP 5: Cache new products ────────────────────────────────────
    if (!cached && offProduct) {
      const { error: insertError } = await supabase
        .from('products')
        .upsert({
          barcode:       offProduct.barcode,
          name:          offProduct.name,
          brand:         offProduct.brand,
          category,
          image_url:     offProduct.image_url,
          nutrients:     rawNutrients,
          calories:      norm.energy_kcal      ?? null,
          sugar:         norm.sugar            ?? null,
          saturated_fat: norm.saturated_fat    ?? null,
          fiber:         norm.fiber            ?? null,
          salt:          rawNutrients.salt_100g ?? (norm.sodium != null ? +(norm.sodium / 1000 * 2.5).toFixed(4) : null),
          base_score:    score,
          updated_at:    new Date().toISOString(),
        }, { onConflict: 'barcode' });

      if (insertError) {
        console.error('[Cache] Insert failed:', insertError.message);
      } else {
        console.log(`[Cache SET] ${barcode}`);
      }
    }

    // ── STEP 6: Alternatives ──────────────────────────────────────────
    const alternatives = await getAlternatives({
      category,
      currentScore:     score,
      currentBarcode:   barcode,
      currentNutrients: rawNutrients,
      modifiers,
      userContext,
    });

    // ── STEP 7: Respond ───────────────────────────────────────────────
    return res.json({
      success: true,
      source: cached ? 'cache' : 'open_food_facts',
      product: {
        barcode,
        name:       productData.name,
        brand:      productData.brand,
        category,
        image_url:  productData.image_url,
        nutriscore: productData.nutriscore ?? null,
        nutrients: {
          sugar_g:          norm.sugar,
          saturated_fat_g:  norm.saturated_fat,
          sodium_mg:        norm.sodium,
          energy_kcal:      norm.energy_kcal,
          fiber_g:          norm.fiber,
          protein_g:        norm.protein,
          nova_group:       norm.nova_group,
          additives_count:  norm.additives_count,
        },
        evaluation: {
          score,
          grade,
          color,
          display:  `${score}/100`,
          breakdown,
        },
        description,
        warnings,
        tips,
        alternatives,
      },
    });
  } catch (err) {
    console.error('[getProduct] Unexpected error:', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
}

module.exports = { getProduct };