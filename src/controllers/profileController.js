const supabase = require('../config/supabase');
const { goalToModifiers } = require('../services/personalizationService');

async function saveProfile(req, res) {
  try {
    const userId = req.user.id;
    const { age, weight, health_goal, dietary_preference } = req.body;

    const modifiers = goalToModifiers(health_goal, dietary_preference);

    const { error } = await supabase.from('user_profiles').upsert({
      user_id: userId,
      age,
      weight,
      health_goal,
      dietary_preference,
      ...modifiers,
    });

    if (error) return res.status(500).json({ success: false, message: error.message });

    return res.json({ success: true, message: 'Profile saved', modifiers });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function getProfile(req, res) {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('user_profiles')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ success: false, message: error.message });
    }

    return res.json({ success: true, profile: data || null });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { saveProfile, getProfile };