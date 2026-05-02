const supabase = require('../config/supabase');

async function updateGamification(userId, score) {
  const today = new Date().toISOString().split('T')[0];

  // Get current gamification row
  let { data: gam } = await supabase
    .from('gamification')
    .select('*')
    .eq('user_id', userId)
    .single();

  let total_points = gam ? gam.total_points : 0;
  let current_streak = gam ? gam.current_streak : 0;
  let longest_streak = gam ? gam.longest_streak : 0;
  const last_scan_date = gam ? gam.last_scan_date : null;

  // Points
  if (score >= 4) total_points += 10;
  else if (score === 3) total_points += 5;

  // Streak
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];

  if (last_scan_date === yesterdayStr) {
    current_streak += 1;
  } else if (last_scan_date === today) {
    // Already scanned today, no change to streak
  } else {
    current_streak = 1;
  }

  if (current_streak > longest_streak) longest_streak = current_streak;

  // Healthy percentage
  const { count: totalScans } = await supabase
    .from('scans')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  const { count: healthyScans } = await supabase
    .from('scans')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('score', 4);

  const healthy_percentage =
    totalScans > 0 ? Math.round((healthyScans / totalScans) * 100) : 0;

  // Upsert
  await supabase.from('gamification').upsert({
    user_id: userId,
    total_points,
    current_streak,
    longest_streak,
    healthy_percentage,
    last_scan_date: today,
  });

  return { total_points, current_streak, longest_streak, healthy_percentage };
}

module.exports = { updateGamification };