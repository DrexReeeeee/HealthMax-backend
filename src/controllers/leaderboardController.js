// controllers/leaderboardController.js
const supabase = require('../config/supabase');

async function getLeaderboard(req, res) {
  try {
    const userId = req.user.id;

    const { data: gamData, error: gamError } = await supabase
      .from('gamification')
      .select('user_id, total_points, current_streak, longest_streak, healthy_percentage')
      .order('total_points', { ascending: false })
      .limit(10);

    console.log('gamError:', gamError);
    console.log('gamData count:', gamData?.length);
    console.log('gamData:', JSON.stringify(gamData, null, 2));

    if (gamError) {
      return res.status(500).json({ success: false, message: gamError.message });
    }

    if (!gamData || gamData.length === 0) {
      return res.json({ success: true, leaderboard: [] });
    }

    const userIds = gamData.map(g => g.user_id);

    const { data: profileData, error: profileError } = await supabase
      .from('user_profiles')
      .select('user_id, username')
      .in('user_id', userIds);

    console.log('profileError:', profileError);
    console.log('profileData:', JSON.stringify(profileData, null, 2));

    const profileMap = {};
    (profileData || []).forEach(p => {
      profileMap[p.user_id] = p;
    });

    const leaderboard = gamData.map((row, index) => ({
      rank: index + 1,
      user_id: row.user_id,
      username: profileMap[row.user_id]?.username || 'Anonymous',
      avatar_url: null,
      total_points: row.total_points,
      current_streak: row.current_streak,
      longest_streak: row.longest_streak,
      healthy_percentage: row.healthy_percentage,
      is_me: row.user_id === userId,
    }));

    console.log('Final leaderboard:', JSON.stringify(leaderboard, null, 2));

    return res.json({ success: true, leaderboard });
  } catch (err) {
    console.error('Leaderboard catch error:', err);
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { getLeaderboard };