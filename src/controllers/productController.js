const axios = require('axios');
const supabase = require('../config/supabase');
const { calculateScore, generateWarnings, getScoreColor } = require('../services/scoringService');
const { getAlternatives } = require('../services/alternativeService');
const { buildModifiers } = require('../services/personalizationService');

// Open Food Facts base URL
const OFF_BASE_URL = 'https://world.openfoodfacts.org/api/v0/product';

/**
 * Safely extracts a nutrient value from OFF nutriments object.
 * OFF sometimes uses _100g suffix, sometimes not.
 */
function getNutrient(nutriments, ...keys) {
  for (const key of keys) {
    const val = nutriments[`${key}_100g`] ?? nutriments[key];
    if (val !== undefined && val !== null && !isNaN(val)) {
      return parseFloat(val);
    }
  }
  return 0;
}

/**
 * Fetches product from Open Food Facts API.
 * Returns normalized product object or null if not found.
 */
async function fetchFromOFF(barcode) {
  try {
    const url = `${OFF_BASE_URL}/${barcode}.json`;
    console.log(`[OFF] Fetching: ${url}`);

    const response = await axios.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent': 'FitMax/1.0 (fitmax@gmail.com)', // OFF requires a User-Agent
      },
    });

    const data = response.data;

    // OFF returns status 0 if product not found
    if (!data || data.status === 0 || !data.product) {
      console.log(`[OFF] Product not found for barcode: ${barcode}`);
      return null;
    }

    const p = data.product;
    const n = p.nutriments || {};

    // Extract nutrients safely
    const sugar = getNutrient(n, 'sugars');
    const salt = getNutrient(n, 'salt');
    const saturated_fat = getNutrient(n, 'saturated-fat', 'saturated_fat');
    const fiber = getNutrient(n, 'fiber');
    const calories = getNutrient(n, 'energy-kcal', 'energy_kcal', 'energy');

    // Extract category — OFF returns array like ["en:beverages", "en:juices"]
    let category = 'General';
    if (p.categories_tags && p.categories_tags.length > 0) {
      // Try to find an English category
      const englishCat = p.categories_tags.find(c => c.startsWith('en:'));
      if (englishCat) {
        category = englishCat
          .replace('en:', '')
          .split('-')
          .map(w => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
      }
    }

    return {
      barcode,
      name: p.product_name_en || p.product_name || 'Unknown Product',
      brand: p.brands || 'Unknown Brand',
      category,
      image_url: p.image_front_url || p.image_url || null,
      sugar,
      salt,
      saturated_fat,
      fiber,
      calories,
    };
  } catch (err) {
    if (err.code === 'ECONNABORTED') {
      console.error('[OFF] Request timed out');
    } else {
      console.error('[OFF] Error:', err.message);
    }
    return null;
  }
}

async function getProduct(req, res) {
  try {
    const { barcode } = req.params;
    const userId = req.user?.id;

    // Validate barcode format (digits only, 8–14 chars)
    if (!/^\d{8,14}$/.test(barcode)) {
      return res.status(400).json({
        success: false,
        message: 'Invalid barcode format. Must be 8–14 digits.',
      });
    }

    // ── STEP 1: Check Supabase product cache ──────────────────────────
    let { data: cachedProduct } = await supabase
      .from('products')
      .select('*')
      .eq('barcode', barcode)
      .single();

    let product = cachedProduct;

    // ── STEP 2: If not cached, fetch from Open Food Facts ─────────────
    if (!product) {
      console.log(`[Cache MISS] Barcode ${barcode} — calling Open Food Facts`);

      const offProduct = await fetchFromOFF(barcode);

      if (!offProduct) {
        return res.status(404).json({
          success: false,
          message: 'Product not found. Try scanning another barcode or add it manually.',
        });
      }

      // Calculate base score (no personalization yet)
      const base_score = calculateScore({
        sugar: offProduct.sugar,
        salt: offProduct.salt,
        saturated_fat: offProduct.saturated_fat,
        fiber: offProduct.fiber,
      });

      const newProduct = { ...offProduct, base_score };

      // Cache in Supabase so we don't call OFF again
      const { error: insertError } = await supabase
        .from('products')
        .upsert(newProduct, { onConflict: 'barcode' });

      if (insertError) {
        console.error('[Cache] Failed to cache product:', insertError.message);
      } else {
        console.log(`[Cache SET] Barcode ${barcode} cached successfully`);
      }

      product = newProduct;
    } else {
      console.log(`[Cache HIT] Barcode ${barcode} served from cache`);
    }

    // ── STEP 3: Get user personalization modifiers (if signed in) ──────
    let modifiers = {};
    if (userId) {
      const { data: profile } = await supabase
        .from('user_profiles')
        .select('sugar_modifier, salt_modifier, fat_modifier')
        .eq('user_id', userId)
        .single();

      if (profile) {
        modifiers = buildModifiers(profile);
        console.log(`[Personalization] Modifiers for user ${userId}:`, modifiers);
      }
    }

    // ── STEP 4: Calculate personalized score & warnings ────────────────
    const nutrients = {
      sugar: product.sugar,
      salt: product.salt,
      saturated_fat: product.saturated_fat,
      fiber: product.fiber,
    };

    const finalScore = calculateScore(nutrients, modifiers);
    const warnings = generateWarnings(nutrients, modifiers);
    const scoreColor = getScoreColor(finalScore);

    // ── STEP 5: Get alternatives (same category, higher base score) ────
    const alternatives = await getAlternatives(product.category, product.base_score, barcode);

    // ── STEP 6: Build & return response ───────────────────────────────
    return res.json({
      success: true,
      source: cachedProduct ? 'cache' : 'open_food_facts',
      product: {
        barcode: product.barcode,
        name: product.name,
        brand: product.brand,
        category: product.category,
        image_url: product.image_url,
        nutrients: {
          sugar: product.sugar,
          salt: product.salt,
          saturated_fat: product.saturated_fat,
          fiber: product.fiber,
          calories: product.calories,
        },
        score: finalScore,
        score_color: scoreColor,
        warnings,
        alternatives,
      },
    });
  } catch (err) {
    console.error('[getProduct] Unexpected error:', err);
    return res.status(500).json({ success: false, message: 'Server error. Please try again.' });
  }
}

module.exports = { getProduct };