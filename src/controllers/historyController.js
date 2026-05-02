const supabase = require('../config/supabase');
const { updateGamification } = require('../services/gamificationService');

async function saveScan(req, res) {
  try {
    const userId = req.user.id;
    const { barcode, score } = req.body;

    if (!barcode || score === undefined) {
      return res.status(400).json({ success: false, message: 'barcode and score are required' });
    }

    // Insert scan
    const { error } = await supabase.from('scans').insert({
      user_id: userId,
      barcode,
      score,
    });

    if (error) return res.status(500).json({ success: false, message: error.message });

    // Update gamification
    const gamification = await updateGamification(userId, score);

    return res.json({ success: true, gamification });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function getHistory(req, res) {
  try {
    const userId = req.user.id;
    const { filter } = req.query; // 'all', 'healthy', 'unhealthy'

    let query = supabase
      .from('scans')
      .select(`
        id,
        score,
        scanned_at,
        products (
          barcode,
          name,
          brand,
          category,
          image_url
        )
      `)
      .eq('user_id', userId)
      .order('scanned_at', { ascending: false });

    if (filter === 'healthy') query = query.gte('score', 4);
    else if (filter === 'unhealthy') query = query.lte('score', 2);

    const { data, error } = await query;

    if (error) return res.status(500).json({ success: false, message: error.message });

    return res.json({ success: true, history: data });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { saveScan, getHistory };