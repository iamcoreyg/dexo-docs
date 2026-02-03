require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const path = require('path');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Database
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: true }
});

// Auth
const APP_TOKEN = process.env.APP_TOKEN;

// Cookie parser
app.use((req, res, next) => {
  req.cookies = {};
  const cookieHeader = req.headers.cookie;
  if (cookieHeader) {
    cookieHeader.split(';').forEach(cookie => {
      const [name, value] = cookie.trim().split('=');
      req.cookies[name] = value;
    });
  }
  next();
});

// Auth endpoint
app.get('/auth', (req, res) => {
  const { token } = req.query;
  if (token === APP_TOKEN) {
    res.setHeader('Set-Cookie', `app_token=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=31536000`);
    res.redirect('/');
  } else {
    res.status(401).send('Invalid token');
  }
});

// Auth middleware
function requireAuth(req, res, next) {
  // Allow API access with Bearer token
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ') && authHeader.slice(7) === APP_TOKEN) {
    return next();
  }
  // Allow browser access with cookie
  if (req.cookies.app_token === APP_TOKEN) {
    return next();
  }
  res.status(401).json({ error: 'Unauthorized' });
}

// ============ API Routes ============

// List all doc reviews
app.get('/api/reviews', requireAuth, async (req, res) => {
  const result = await pool.query('SELECT * FROM docs_reviews ORDER BY reviewed_at DESC');
  res.json(result.rows);
});

// Log a doc review
app.post('/api/reviews', requireAuth, async (req, res) => {
  const { doc_slug, doc_title, notes } = req.body;
  const result = await pool.query(
    'INSERT INTO docs_reviews (doc_slug, doc_title, notes, reviewed_at) VALUES ($1, $2, $3, NOW()) RETURNING *',
    [doc_slug, doc_title, notes]
  );
  res.json(result.rows[0]);
});

// Get last review for a doc
app.get('/api/reviews/:slug', requireAuth, async (req, res) => {
  const result = await pool.query(
    'SELECT * FROM docs_reviews WHERE doc_slug = $1 ORDER BY reviewed_at DESC LIMIT 1',
    [req.params.slug]
  );
  res.json(result.rows[0] || null);
});

// List all issues
app.get('/api/issues', requireAuth, async (req, res) => {
  const status = req.query.status || 'open';
  const query = status === 'all' 
    ? 'SELECT * FROM docs_issues ORDER BY created_at DESC'
    : 'SELECT * FROM docs_issues WHERE status = $1 ORDER BY created_at DESC';
  const result = status === 'all' 
    ? await pool.query(query)
    : await pool.query(query, [status]);
  res.json(result.rows);
});

// Create an issue
app.post('/api/issues', requireAuth, async (req, res) => {
  const { doc_slug, doc_title, issue_type, description, suggested_fix } = req.body;
  const result = await pool.query(
    `INSERT INTO docs_issues (doc_slug, doc_title, issue_type, description, suggested_fix, status, created_at) 
     VALUES ($1, $2, $3, $4, $5, 'open', NOW()) RETURNING *`,
    [doc_slug, doc_title, issue_type, description, suggested_fix]
  );
  res.json(result.rows[0]);
});

// Update issue status
app.patch('/api/issues/:id', requireAuth, async (req, res) => {
  const { status, resolution_notes } = req.body;
  const resolved_at = (status === 'resolved' || status === 'dismissed') ? 'NOW()' : 'NULL';
  const result = await pool.query(
    `UPDATE docs_issues SET status = $1, resolution_notes = $2, resolved_at = ${resolved_at} WHERE id = $3 RETURNING *`,
    [status, resolution_notes, req.params.id]
  );
  res.json(result.rows[0]);
});

// List doc gaps (from support)
app.get('/api/gaps', requireAuth, async (req, res) => {
  const status = req.query.status || 'open';
  const query = status === 'all'
    ? 'SELECT * FROM docs_gaps ORDER BY created_at DESC'
    : 'SELECT * FROM docs_gaps WHERE status = $1 ORDER BY created_at DESC';
  const result = status === 'all'
    ? await pool.query(query)
    : await pool.query(query, [status]);
  res.json(result.rows);
});

// Log a doc gap
app.post('/api/gaps', requireAuth, async (req, res) => {
  const { ticket_id, ticket_subject, description, suggested_doc } = req.body;
  const result = await pool.query(
    `INSERT INTO docs_gaps (ticket_id, ticket_subject, description, suggested_doc, status, created_at)
     VALUES ($1, $2, $3, $4, 'open', NOW()) RETURNING *`,
    [ticket_id, ticket_subject, description, suggested_doc]
  );
  res.json(result.rows[0]);
});

// Update gap status
app.patch('/api/gaps/:id', requireAuth, async (req, res) => {
  const { status, doc_created_slug } = req.body;
  const result = await pool.query(
    'UPDATE docs_gaps SET status = $1, doc_created_slug = $2 WHERE id = $3 RETURNING *',
    [status, doc_created_slug, req.params.id]
  );
  res.json(result.rows[0]);
});

// Dashboard stats
app.get('/api/stats', requireAuth, async (req, res) => {
  const [issues, gaps, reviews] = await Promise.all([
    pool.query("SELECT status, COUNT(*) as count FROM docs_issues GROUP BY status"),
    pool.query("SELECT status, COUNT(*) as count FROM docs_gaps GROUP BY status"),
    pool.query("SELECT COUNT(*) as count, MAX(reviewed_at) as last_review FROM docs_reviews")
  ]);
  
  res.json({
    issues: issues.rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count) }), {}),
    gaps: gaps.rows.reduce((acc, r) => ({ ...acc, [r.status]: parseInt(r.count) }), {}),
    reviews: {
      total: parseInt(reviews.rows[0]?.count || 0),
      last_review: reviews.rows[0]?.last_review
    }
  });
});

// ============ Static/UI ============
app.use(express.static('public', { index: false }));

app.get('/', requireAuth, async (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ============ DB Setup ============
async function setupDb() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs_reviews (
      id SERIAL PRIMARY KEY,
      doc_slug VARCHAR(255) NOT NULL,
      doc_title VARCHAR(500),
      notes TEXT,
      reviewed_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs_issues (
      id SERIAL PRIMARY KEY,
      doc_slug VARCHAR(255),
      doc_title VARCHAR(500),
      issue_type VARCHAR(50) NOT NULL,
      description TEXT NOT NULL,
      suggested_fix TEXT,
      status VARCHAR(20) DEFAULT 'open',
      resolution_notes TEXT,
      created_at TIMESTAMP DEFAULT NOW(),
      resolved_at TIMESTAMP
    )
  `);
  
  await pool.query(`
    CREATE TABLE IF NOT EXISTS docs_gaps (
      id SERIAL PRIMARY KEY,
      ticket_id VARCHAR(100),
      ticket_subject VARCHAR(500),
      description TEXT NOT NULL,
      suggested_doc VARCHAR(255),
      status VARCHAR(20) DEFAULT 'open',
      doc_created_slug VARCHAR(255),
      created_at TIMESTAMP DEFAULT NOW()
    )
  `);
  
  console.log('Database tables ready');
}

const PORT = process.env.PORT || 3000;
setupDb().then(() => {
  app.listen(PORT, () => console.log(`Doc tracker running on port ${PORT}`));
});
