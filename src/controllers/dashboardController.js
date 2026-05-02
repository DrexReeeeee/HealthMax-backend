const supabase = require('../config/supabase');

async function getDashboard(req, res) {
  try {
    const userId = req.user.id;

    const { count: totalScans } = await supabase
      .from('scans')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId);

    const { count: healthyScans } = await supabase
      .from('scans')
      .select('*', { count: 'exact', head: true })
      .eq('user_id', userId)
      .gte('score', 4);

    const { data: gam } = await supabase
      .from('gamification')
      .select('total_points, current_streak, longest_streak, healthy_percentage')
      .eq('user_id', userId)
      .single();

    return res.json({
      success: true,
      dashboard: {
        total_scans: totalScans || 0,
        healthy_scans: healthyScans || 0,
        healthy_percentage: gam?.healthy_percentage || 0,
        current_streak: gam?.current_streak || 0,
        longest_streak: gam?.longest_streak || 0,
        total_points: gam?.total_points || 0,
      },
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getDashboard };