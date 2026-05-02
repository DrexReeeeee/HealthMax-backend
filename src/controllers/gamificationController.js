const supabase = require('../config/supabase');

async function getGamification(req, res) {
  try {
    const userId = req.user.id;

    const { data, error } = await supabase
      .from('gamification')
      .select('*')
      .eq('user_id', userId)
      .single();

    if (error && error.code !== 'PGRST116') {
      return res.status(500).json({ success: false, message: error.message });
    }

    const gamification = data || {
      total_points: 0,
      current_streak: 0,
      longest_streak: 0,
      healthy_percentage: 0,
    };

    // Compute badges
    const badges = computeBadges(gamification);

    return res.json({ success: true, gamification: { ...gamification, badges } });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

function computeBadges(gam) {
  const badges = [];

  if (gam.total_points >= 100)
    badges.push({ id: 'centurion', label: '💯 Centurion', description: 'Earned 100 points' });
  if (gam.longest_streak >= 7)
    badges.push({ id: 'streak7', label: '🔥 7-Day Streak', description: 'Scanned 7 days in a row' });
  if (gam.healthy_percentage >= 80)
    badges.push({ id: 'health_hero', label: '💚 Health Hero', description: '80%+ healthy choices' });

  return badges;
}

module.exports = { getGamification };