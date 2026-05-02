const supabase = require('../config/supabase');

/**
 * Finds top 3 products in same category with higher score.
 */
async function getAlternatives(category, currentScore, currentBarcode) {
  const { data, error } = await supabase
    .from('products')
    .select('barcode, name, brand, base_score, image_url')
    .eq('category', category)
    .gt('base_score', currentScore)
    .neq('barcode', currentBarcode)
    .order('base_score', { ascending: false })
    .limit(3);

  if (error) return [];
  return data || [];
}

module.exports = { getAlternatives };