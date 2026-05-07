/**
 * scoringService.js
 *
 * Health scoring on a 0–100 scale using a dietitian-inspired model.
 * Based on the Nutri-Score / HCAS (Health Claims Assessment Score) approach:
 *   - Negative points: energy, sugar, saturated fat, sodium, additives
 *   - Positive points: fiber, protein, fruit/veg content
 *   - Personalization modifiers amplify concern, not raw score
 *
 * All nutrient values are expected per 100g/100ml (as returned by Open Food Facts).
 */

// ─── Thresholds (per 100g) ────────────────────────────────────────────────────

const THRESHOLDS = {
  sugar: [
    { limit: 45, penalty: 10 },
    { limit: 40, penalty: 9 },
    { limit: 36, penalty: 8 },
    { limit: 31, penalty: 7 },
    { limit: 27, penalty: 6 },
    { limit: 22.5, penalty: 5 },
    { limit: 18, penalty: 4 },
    { limit: 13.5, penalty: 3 },
    { limit: 9, penalty: 2 },
    { limit: 4.5, penalty: 1 },
  ],
  saturated_fat: [
    { limit: 10, penalty: 10 },
    { limit: 9, penalty: 9 },
    { limit: 8, penalty: 8 },
    { limit: 7, penalty: 7 },
    { limit: 6, penalty: 6 },
    { limit: 5, penalty: 5 },
    { limit: 4, penalty: 4 },
    { limit: 3, penalty: 3 },
    { limit: 2, penalty: 2 },
    { limit: 1, penalty: 1 },
  ],
  sodium: [
    { limit: 900, penalty: 10 },
    { limit: 810, penalty: 9 },
    { limit: 720, penalty: 8 },
    { limit: 630, penalty: 7 },
    { limit: 540, penalty: 6 },
    { limit: 450, penalty: 5 },
    { limit: 360, penalty: 4 },
    { limit: 270, penalty: 3 },
    { limit: 180, penalty: 4 },
    { limit: 90, penalty: 1 },
  ],
  energy_kcal: [
    { limit: 800, penalty: 10 },
    { limit: 720, penalty: 9 },
    { limit: 640, penalty: 8 },
    { limit: 560, penalty: 7 },
    { limit: 480, penalty: 6 },
    { limit: 400, penalty: 5 },
    { limit: 320, penalty: 4 },
    { limit: 240, penalty: 3 },
    { limit: 160, penalty: 2 },
    { limit: 80, penalty: 1 },
  ],
  fiber: [
    { limit: 4.7, points: 5 },
    { limit: 3.7, points: 4 },
    { limit: 2.8, points: 3 },
    { limit: 1.9, points: 2 },
    { limit: 0.9, points: 1 },
  ],
  protein: [
    { limit: 8, points: 5 },
    { limit: 6.4, points: 4 },
    { limit: 4.8, points: 3 },
    { limit: 3.2, points: 2 },
    { limit: 1.6, points: 1 },
  ],
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function getPenalty(value, thresholds) {
  if (value == null || isNaN(value)) return 0;
  for (const { limit, penalty } of thresholds) {
    if (value >= limit) return penalty;
  }
  return 0;
}

function getPoints(value, thresholds) {
  if (value == null || isNaN(value)) return 0;
  for (const { limit, points } of thresholds) {
    if (value >= limit) return points;
  }
  return 0;
}

/**
 * Converts Open Food Facts nutrient keys to our internal format.
 *
 * FIX: fallbacks are now null instead of 0.
 * Returning 0 when data is missing caused "0.0g sugar" to display for
 * products where the value simply wasn't provided — masking missing data.
 * Scoring functions (getPenalty/getPoints) now guard against null safely.
 *
 * OFF key reference:
 *   energy-kcal_100g, energy_100g (kJ), sugars_100g, saturated-fat_100g,
 *   fiber_100g, proteins_100g, salt_100g, sodium_100g
 */
function normalizeNutrients(raw = {}) {
  // Energy: prefer explicit kcal, fall back to kJ ÷ 4.184
  let energy_kcal = raw.energy_kcal_100g ?? null;
  if (energy_kcal == null && raw.energy_100g != null) {
    energy_kcal = raw.energy_100g / 4.184;
  }

  // Sodium: prefer explicit sodium (g→mg), fall back to salt (g→mg via ×400)
  let sodium = null;
  if (raw.sodium_100g != null) {
    sodium = raw.sodium_100g * 1000;          // g → mg
  } else if (raw.salt_100g != null) {
    sodium = raw.salt_100g * 400;             // salt g → sodium mg
  }

  return {
    energy_kcal,
    sugar:         raw.sugars_100g             ?? null,
    saturated_fat: raw['saturated-fat_100g']   ?? null,
    sodium,
    fiber:         raw.fiber_100g              ?? null,
    protein:       raw.proteins_100g           ?? null,
    additives_count: Array.isArray(raw.additives_tags)
      ? raw.additives_tags.length
      : (raw.additives_count ?? 0),
    nova_group: raw.nova_group ?? null,
  };
}

// ─── Core Scorer ──────────────────────────────────────────────────────────────

function calculateScore(rawNutrients, modifiers = {}, userContext = {}) {
  const n = normalizeNutrients(rawNutrients);

  const {
    sugar_modifier = 1,
    salt_modifier  = 1,
    fat_modifier   = 1,
  } = modifiers;

  // ── Negative points ────────────────────────────────────────────────
  const sugarPenalty  = getPenalty((n.sugar  ?? 0) * sugar_modifier, THRESHOLDS.sugar);
  const fatPenalty    = getPenalty((n.saturated_fat ?? 0) * fat_modifier, THRESHOLDS.saturated_fat);
  const sodiumPenalty = getPenalty((n.sodium ?? 0) * salt_modifier,  THRESHOLDS.sodium);
  const energyPenalty = getPenalty(n.energy_kcal ?? 0,               THRESHOLDS.energy_kcal);

  let processingPenalty = 0;
  if (n.nova_group === 4) processingPenalty = 5;
  else if (n.nova_group === 3) processingPenalty = 2;

  const additivesPenalty = Math.min(5, n.additives_count * 0.5);

  const totalNegative = sugarPenalty + fatPenalty + sodiumPenalty + energyPenalty
                      + processingPenalty + additivesPenalty;

  // ── Positive points ────────────────────────────────────────────────
  const fiberPoints   = getPoints(n.fiber   ?? 0, THRESHOLDS.fiber);
  const proteinPoints = getPoints(n.protein ?? 0, THRESHOLDS.protein);
  const totalPositive = fiberPoints + proteinPoints;

  // ── Health-goal adjustment ─────────────────────────────────────────
  let goalAdjustment = 0;
  const goal = userContext.health_goal;
  if (goal === 'low-sugar'     && (n.sugar ?? 0) > 5)            goalAdjustment -= 5;
  if (goal === 'low-sugar'     && (n.sugar ?? 0) <= 2)           goalAdjustment += 3;
  if (goal === 'high-protein'  && (n.protein ?? 0) >= 6)         goalAdjustment += 5;
  if (goal === 'weight-loss'   && (n.energy_kcal ?? 0) > 400)    goalAdjustment -= 5;
  if (goal === 'heart-healthy' && (n.sodium ?? 0) > 450)         goalAdjustment -= 5;
  if (goal === 'heart-healthy' && (n.saturated_fat ?? 0) > 3)    goalAdjustment -= 3;

  // ── Final score ────────────────────────────────────────────────────
  const NEGATIVE_SCALE = 2.22;
  const rawScore = 100
    - (totalNegative * NEGATIVE_SCALE)
    + (totalPositive * 2)
    + goalAdjustment;

  const score = Math.round(Math.min(100, Math.max(0, rawScore)));

  return {
    score,
    grade: scoreToGrade(score),
    breakdown: {
      penalties: {
        sugar:         sugarPenalty,
        saturated_fat: fatPenalty,
        sodium:        sodiumPenalty,
        energy:        energyPenalty,
        processing:    processingPenalty,
        additives:     additivesPenalty,
      },
      bonuses: {
        fiber:           fiberPoints,
        protein:         proteinPoints,
        goal_adjustment: goalAdjustment,
      },
      effective_nutrients: {
        sugar_g:         n.sugar,
        saturated_fat_g: n.saturated_fat,
        sodium_mg:       n.sodium,
        energy_kcal:     n.energy_kcal,
        fiber_g:         n.fiber,
        protein_g:       n.protein,
        nova_group:      n.nova_group,
        additives_count: n.additives_count,
      },
    },
  };
}

// ─── Grade & Color ────────────────────────────────────────────────────────────

function scoreToGrade(score) {
  if (score >= 75) return 'A';
  if (score >= 60) return 'B';
  if (score >= 45) return 'C';
  if (score >= 25) return 'D';
  return 'E';
}

function getScoreColor(score) {
  if (score >= 75) return 'green';
  if (score >= 60) return 'lime';
  if (score >= 45) return 'yellow';
  if (score >= 25) return 'orange';
  return 'red';
}

// ─── Warnings & Tips ──────────────────────────────────────────────────────────

function generateWarnings(rawNutrients, modifiers = {}, userContext = {}) {
  const n = normalizeNutrients(rawNutrients);
  const { sugar_modifier = 1, salt_modifier = 1, fat_modifier = 1 } = modifiers;
  const warnings = [];
  const tips     = [];

  const effectiveSugar  = (n.sugar         ?? 0) * sugar_modifier;
  const effectiveSodium = (n.sodium        ?? 0) * salt_modifier;
  const effectiveFat    = (n.saturated_fat ?? 0) * fat_modifier;

  if (effectiveSugar > 22.5)
    warnings.push('🔴 Very high sugar — significantly increases risk of obesity, insulin resistance, and type 2 diabetes.');
  else if (effectiveSugar > 9)
    warnings.push('🟡 Moderate-high sugar — limit frequency of consumption.');

  if (effectiveSodium > 600)
    warnings.push('🔴 Very high sodium — major risk factor for hypertension and cardiovascular disease.');
  else if (effectiveSodium > 300)
    warnings.push('🟡 Moderate sodium — be mindful of total daily intake.');

  if (effectiveFat > 5)
    warnings.push('🔴 High saturated fat — raises LDL cholesterol.');
  else if (effectiveFat > 2)
    warnings.push('🟡 Moderate saturated fat — consume in moderation.');

  if (n.nova_group === 4)
    warnings.push('🔴 Ultra-processed food (NOVA 4) — associated with higher risk of chronic disease.');
  else if (n.nova_group === 3)
    warnings.push('🟡 Processed food (NOVA 3) — prefer less-processed alternatives when possible.');

  if (n.additives_count > 5)
    warnings.push(`⚠ Contains ${n.additives_count} additives — some may have adverse effects with frequent consumption.`);

  if ((n.fiber ?? 0) < 1.5)
    tips.push('💡 Low fiber — look for whole grain or high-fiber alternatives.');
  if ((n.protein ?? 0) < 2)
    tips.push('💡 Low protein — consider pairing with a protein-rich food.');

  const goal = userContext.health_goal;
  if (goal === 'low-sugar'   && effectiveSugar > 5)
    tips.push('💡 Your low-sugar goal: this product has notable sugar content — limit to occasional consumption.');
  if (goal === 'high-protein' && (n.protein ?? 0) < 5)
    tips.push('💡 Your high-protein goal: this product is not a strong protein source.');
  if (goal === 'weight-loss' && (n.energy_kcal ?? 0) > 400)
    tips.push('💡 Your weight-loss goal: this is a calorie-dense product — watch portion size.');

  return { warnings, tips };
}

// ─── Description ──────────────────────────────────────────────────────────────

function generateDescription(score, breakdown, userContext = {}) {
  const p = breakdown?.penalties ?? {};
  const b = breakdown?.bonuses   ?? {};
  const n = breakdown?.effective_nutrients ?? {};
  const goal = userContext.health_goal;

  let opening = '';
  if (score >= 75)      opening = 'This is a solid, nutritious choice.';
  else if (score >= 60) opening = 'This product is reasonably healthy but has some areas to watch.';
  else if (score >= 45) opening = 'This product is moderate — fine occasionally, but not ideal regularly.';
  else if (score >= 25) opening = 'This product has several nutritional concerns worth noting.';
  else                  opening = 'This product scores poorly across multiple nutritional criteria.';

  const concerns = [];

  if ((p.sugar ?? 0) >= 5)
    concerns.push(`high sugar (${n.sugar_g?.toFixed(1) ?? '?'}g per 100g)`);
  else if ((p.sugar ?? 0) >= 2)
    concerns.push(`moderate sugar (${n.sugar_g?.toFixed(1) ?? '?'}g per 100g)`);

  if ((p.sodium ?? 0) >= 5)
    concerns.push(`very high sodium (${n.sodium_mg != null ? Math.round(n.sodium_mg) : '?'}mg per 100g)`);
  else if ((p.sodium ?? 0) >= 3)
    concerns.push(`elevated sodium (${n.sodium_mg != null ? Math.round(n.sodium_mg) : '?'}mg per 100g)`);

  if ((p.saturated_fat ?? 0) >= 5)
    concerns.push(`high saturated fat (${n.saturated_fat_g?.toFixed(1) ?? '?'}g per 100g)`);
  else if ((p.saturated_fat ?? 0) >= 2)
    concerns.push(`moderate saturated fat (${n.saturated_fat_g?.toFixed(1) ?? '?'}g per 100g)`);

  if ((p.energy ?? 0) >= 5)
    concerns.push(`high calorie density (${n.energy_kcal != null ? Math.round(n.energy_kcal) : '?'} kcal per 100g)`);

  if ((p.processing ?? 0) >= 5)
    concerns.push('ultra-processed formulation (NOVA group 4)');
  else if ((p.processing ?? 0) >= 2)
    concerns.push('moderately processed (NOVA group 3)');

  if ((p.additives ?? 0) >= 3)
    concerns.push(`${n.additives_count} additives`);

  const positives = [];

  if ((b.fiber ?? 0) >= 4)
    positives.push(`excellent fiber content (${n.fiber_g?.toFixed(1) ?? '?'}g)`);
  else if ((b.fiber ?? 0) >= 2)
    positives.push(`decent fiber (${n.fiber_g?.toFixed(1) ?? '?'}g)`);

  if ((b.protein ?? 0) >= 4)
    positives.push(`good protein (${n.protein_g?.toFixed(1) ?? '?'}g)`);
  else if ((b.protein ?? 0) >= 2)
    positives.push(`moderate protein (${n.protein_g?.toFixed(1) ?? '?'}g)`);

  let concernSentence = '';
  if (concerns.length === 1) {
    concernSentence = `The main concern is its ${concerns[0]}.`;
  } else if (concerns.length === 2) {
    concernSentence = `Key concerns are its ${concerns[0]} and ${concerns[1]}.`;
  } else if (concerns.length >= 3) {
    const last = concerns[concerns.length - 1];
    const rest = concerns.slice(0, -1);
    concernSentence = `Key concerns include its ${rest.join(', ')}, and ${last}.`;
  }

  let positiveSentence = '';
  if (positives.length === 1) {
    positiveSentence = `On the plus side, it has ${positives[0]}.`;
  } else if (positives.length >= 2) {
    positiveSentence = `On the plus side, it provides ${positives.join(' and ')}.`;
  }

  let goalNote = '';
  if (goal === 'low-sugar' && (p.sugar ?? 0) >= 2)
    goalNote = 'Given your low-sugar goal, you may want to limit how often you consume this.';
  else if (goal === 'low-sugar' && (p.sugar ?? 0) === 0)
    goalNote = 'The low sugar content aligns well with your low-sugar goal.';
  else if (goal === 'high-protein' && (b.protein ?? 0) >= 3)
    goalNote = 'The protein content supports your high-protein goal.';
  else if (goal === 'high-protein' && (b.protein ?? 0) === 0)
    goalNote = 'This product is not a strong source of protein for your high-protein goal.';
  else if (goal === 'weight-loss' && (p.energy ?? 0) >= 4)
    goalNote = 'The high calorie density is worth watching for your weight-loss goal.';
  else if (goal === 'heart-healthy' && ((p.sodium ?? 0) >= 4 || (p.saturated_fat ?? 0) >= 4))
    goalNote = 'The sodium and fat levels are a concern for your heart-healthy goal.';

  return [opening, concernSentence, positiveSentence, goalNote]
    .filter(Boolean)
    .join(' ');
}

module.exports = {
  calculateScore,
  generateWarnings,
  generateDescription,
  getScoreColor,
  scoreToGrade,
  normalizeNutrients,
};