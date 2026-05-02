const supabase = require('../config/supabase');
const { goalToModifiers } = require('../services/personalizationService');

async function register(req, res) {
  try {
    const {
      email,
      password,
      age,
      weight,
      health_goal,
      dietary_preference,
    } = req.body;

    // 1. Create auth user
    const { data, error } = await supabase.auth.admin.createUser({
      email,
      password,
      email_confirm: true,
    });

    if (error) return res.status(400).json({ success: false, message: error.message });

    const userId = data.user.id;

    // 2. Build modifiers from health goal
    const modifiers = goalToModifiers(health_goal, dietary_preference);

    // 3. Save profile
    const { error: profileError } = await supabase.from('user_profiles').insert({
      user_id: userId,
      age: age || null,
      weight: weight || null,
      health_goal: health_goal || null,
      dietary_preference: dietary_preference || null,
      ...modifiers,
    });

    if (profileError) {
      // Auth user was created but profile failed — still return success but warn
      console.error('Profile save failed:', profileError.message);
      return res.status(201).json({
        success: true,
        warning: 'Account created but profile could not be saved. Please update via /api/profile.',
        user: data.user,
      });
    }

    // 4. Initialize gamification row
    await supabase.from('gamification').insert({
      user_id: userId,
      total_points: 0,
      current_streak: 0,
      longest_streak: 0,
      healthy_percentage: 0,
    });

    return res.status(201).json({
      success: true,
      message: 'Account created successfully',
      user: data.user,
      modifiers,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

async function login(req, res) {
  try {
    const { email, password } = req.body;

    const { data, error } = await supabase.auth.signInWithPassword({ email, password });

    if (error) return res.status(401).json({ success: false, message: error.message });

    return res.json({
      success: true,
      access_token: data.session.access_token,
      user: data.user,
    });
  } catch (err) {
    return res.status(500).json({ success: false, message: err.message });
  }
}

module.exports = { register, login };