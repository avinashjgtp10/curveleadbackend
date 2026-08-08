const { query } = require('../config/db');

// GET /api/teams
const getTeams = async (req, res) => {
  try {
    const result = await query(
      `SELECT t.*, (SELECT COUNT(*) FROM users WHERE team_id = t.id) as member_count
       FROM teams t WHERE t.tenant_id = $1 ORDER BY t.name ASC`,
      [req.tenantId]
    );
    res.json({ teams: result.rows });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// POST /api/teams
const createTeam = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Team name is required.' });

    const result = await query(
      'INSERT INTO teams (tenant_id, name) VALUES ($1,$2) RETURNING *',
      [req.tenantId, name.trim()]
    );
    res.status(201).json({ team: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// PUT /api/teams/:id
const updateTeam = async (req, res) => {
  try {
    const { name } = req.body;
    if (!name?.trim()) return res.status(400).json({ error: 'Team name is required.' });

    const result = await query(
      'UPDATE teams SET name = $1 WHERE id = $2 AND tenant_id = $3 RETURNING *',
      [name.trim(), req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Team not found.' });
    res.json({ team: result.rows[0] });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

// DELETE /api/teams/:id
const deleteTeam = async (req, res) => {
  try {
    const result = await query(
      'DELETE FROM teams WHERE id = $1 AND tenant_id = $2 RETURNING id',
      [req.params.id, req.tenantId]
    );
    if (!result.rows.length) return res.status(404).json({ error: 'Team not found.' });
    res.json({ message: 'Deleted.' });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Failed.' }); }
};

module.exports = { getTeams, createTeam, updateTeam, deleteTeam };
