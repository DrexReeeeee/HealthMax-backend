/**
 * Calculates health score from 1–5 based on nutrient values.
 * Optionally applies personalization modifiers.
 */
function calculateScore(nutrients, modifiers = {}) {
  const {
    sugar = 0,
    salt = 0,
    saturated_fat = 0,
    fiber = 0,
  } = nutrients;

  const {
    sugar_modifier = 1,
    salt_modifier = 1,
    fat_modifier = 1,
  } = modifiers;

  // Apply personalization modifiers
  const effectiveSugar = sugar * sugar_modifier;
  const effectiveSalt = salt * salt_modifier;
  const effectiveFat = saturated_fat * fat_modifier;

  let score = 5;

  // Sugar penalties
  if (effectiveSugar > 15) score -= 2;
  else if (effectiveSugar > 5) score -= 1;

  // Salt penalties
  if (effectiveSalt > 1) score -= 2;
  else if (effectiveSalt > 0.5) score -= 1;

  // Saturated fat penalties
  if (effectiveFat > 10) score -= 2;
  else if (effectiveFat > 3) score -= 1;

  // Fiber bonus
  if (fiber >= 3) score += 1;
  else if (fiber < 1) score -= 1;

  // Clamp between 1 and 5
  return Math.min(5, Math.max(1, score));
}

function generateWarnings(nutrients, modifiers = {}) {
  const warnings = [];
  const {
    sugar = 0,
    salt = 0,
    saturated_fat = 0,
  } = nutrients;

  const {
    sugar_modifier = 1,
    salt_modifier = 1,
    fat_modifier = 1,
  } = modifiers;

  if (sugar * sugar_modifier > 15)
    warnings.push('⚠ High sugar may increase risk of obesity and diabetes.');
  if (salt * salt_modifier > 1)
    warnings.push('⚠ High salt may increase blood pressure.');
  if (saturated_fat * fat_modifier > 10)
    warnings.push('⚠ High saturated fat may increase cholesterol levels.');

  return warnings;
}

function getScoreColor(score) {
  if (score <= 2) return 'red';
  if (score === 3) return 'yellow';
  return 'green';
}

module.exports = { calculateScore, generateWarnings, getScoreColor };