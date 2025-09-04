import express from 'express';
import cors from 'cors';
import path from 'path';
import { fileURLToPath } from 'url';
import { v4 as uuidv4 } from 'uuid';
import { loadDB, saveDB } from './data/store.js';
import { haversineKm } from './utils/geo.js';

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// In-memory auth & OTP (prototype only)
const tokens = new Map(); // token -> userId
const pendingOtps = new Map(); // phone -> { otp, role, createdAt }
const sseClients = new Map(); // userId -> Set(res)

function authMiddleware(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token || !tokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  req.userId = tokens.get(token);
  next();
}

function getUser(db, userId) {
  return db.users.find(u => u.id === userId);
}

// Serve static web UI
app.use(express.static(path.join(__dirname, 'public')));

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// Start OTP (prototype: always 123456 and returned in response)
app.post('/api/auth/otp/start', (req, res) => {
  const { phone, role } = req.body || {};
  if (!phone || !role) return res.status(400).json({ error: 'phone and role required' });
  const otp = '123456';
  pendingOtps.set(phone, { otp, role, createdAt: Date.now() });
  res.json({ requestId: uuidv4(), otp }); // NOTE: exposing OTP only for prototype
});

// Verify OTP -> returns token and user
app.post('/api/auth/otp/verify', (req, res) => {
  const { phone, role, otp, name, language } = req.body || {};
  const pending = pendingOtps.get(phone);
  if (!pending || pending.otp !== otp || pending.role !== role) {
    return res.status(400).json({ error: 'Invalid OTP' });
  }
  pendingOtps.delete(phone);
  const db = loadDB();
  let user = db.users.find(u => u.phone === phone);
  if (!user) {
    user = { id: uuidv4(), phone, role, name: name || '', language: language || 'en', rating: 0, created_at: new Date().toISOString() };
    db.users.push(user);
    saveDB(db);
  } else if (user.role !== role) {
    user.role = role; // allow switching for prototype
    saveDB(db);
  }
  const token = uuidv4();
  tokens.set(token, user.id);
  res.json({ token, user });
});

// Get current user
app.get('/api/me', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = getUser(db, req.userId);
  res.json({ user });
});

// Upsert worker profile
app.post('/api/workers/me/profile', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = getUser(db, req.userId);
  if (!user) return res.status(404).json({ error: 'User not found' });
  if (user.role !== 'worker') return res.status(400).json({ error: 'Not a worker' });

  const { name, lat, lng, radiusKm, skills, rate, availableToday } = req.body || {};
  if (name) user.name = name;

  let worker = db.workers.find(w => w.userId === user.id);
  if (!worker) {
    worker = { userId: user.id, lat: null, lng: null, radiusKm: 5, skills: [], rate: 0, availability: { today: false }, reliability: 0, reviews: 0 };
    db.workers.push(worker);
  }

  if (lat !== undefined) worker.lat = parseFloat(lat);
  if (lng !== undefined) worker.lng = parseFloat(lng);
  if (radiusKm !== undefined) worker.radiusKm = parseFloat(radiusKm);
  if (Array.isArray(skills)) worker.skills = skills.map(s => String(s).trim()).filter(Boolean);
  if (rate !== undefined) worker.rate = parseFloat(rate);
  if (availableToday !== undefined) worker.availability = { ...(worker.availability || {}), today: !!availableToday };

  saveDB(db);
  res.json({ user, worker });
});

// Nearby workers search (public)
app.get('/api/workers/nearby', (req, res) => {
  const db = loadDB();
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || '5');
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'lat,lng required' });

  const skillsQuery = (req.query.skills || '').toString().split(',').map(s => s.trim()).filter(Boolean);
  const minRate = req.query.minRate ? parseFloat(req.query.minRate) : null;
  const maxRate = req.query.maxRate ? parseFloat(req.query.maxRate) : null;
  const onlyAvailable = req.query.onlyAvailable === 'true';

  const results = db.workers
    .filter(w => w.lat != null && w.lng != null)
    .map(w => ({ w, dist: haversineKm(lat, lng, w.lat, w.lng) }))
    .filter(({ w, dist }) => dist <= (radius || 5))
    .filter(({ w }) => {
      if (!skillsQuery.length) return true;
      const ws = (w.skills || []).map(s => s.toLowerCase());
      return skillsQuery.every(s => ws.includes(s.toLowerCase()));
    })
    .filter(({ w }) => {
      if (minRate != null && w.rate < minRate) return false;
      if (maxRate != null && w.rate > maxRate) return false;
      return true;
    })
    .filter(({ w }) => !onlyAvailable || (w.availability && w.availability.today))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 50)
    .map(({ w, dist }) => {
      const user = db.users.find(u => u.id === w.userId) || {};
      return {
        userId: w.userId,
        name: user.name || 'Worker',
        phone: user.phone,
        distanceKm: Number(dist.toFixed(2)),
        rate: w.rate,
        skills: w.skills,
        availableToday: w.availability?.today || false
      };
    });

  res.json({ count: results.length, results });
});

// Create a job (farmer)
app.post('/api/jobs', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = getUser(db, req.userId);
  if (user.role !== 'farmer') return res.status(400).json({ error: 'Not a farmer' });

  const { title, description, wage, numWorkers, startAt, durationHours, lat, lng, radiusKm } = req.body || {};
  if (lat == null || lng == null) return res.status(400).json({ error: 'lat,lng required' });

  const job = {
    id: uuidv4(),
    farmerId: user.id,
    title: title || 'Farm work',
    description: description || '',
    wage: parseFloat(wage || 0),
    numWorkers: parseInt(numWorkers || 1),
    startAt: startAt || new Date().toISOString(),
    durationHours: parseFloat(durationHours || 8),
    lat: parseFloat(lat),
    lng: parseFloat(lng),
    radiusKm: parseFloat(radiusKm || 5),
    status: 'open',
    createdAt: new Date().toISOString()
  };
  db.jobs.push(job);
  saveDB(db);
  res.json({ job });
  notifyWorkersForJob(db, job);
});

function notifyWorkersForJob(db, job) {
  const candidates = db.workers
    .filter(w => w.lat != null && w.lng != null)
    .map(w => ({ w, dist: haversineKm(job.lat, job.lng, w.lat, w.lng) }))
    .filter(({ w, dist }) => dist <= job.radiusKm)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 50);

  candidates.forEach(({ w, dist }) => {
    pushEvent(w.userId, {
      type: 'job_alert',
      jobId: job.id,
      title: job.title,
      wage: job.wage,
      distanceKm: Number(dist.toFixed(2)),
      lat: job.lat,
      lng: job.lng
    });
  });
}

// Jobs near a coordinate (for workers)
app.get('/api/jobs/nearby', (req, res) => {
  const db = loadDB();
  const lat = parseFloat(req.query.lat);
  const lng = parseFloat(req.query.lng);
  const radius = parseFloat(req.query.radius || '5');
  if (Number.isNaN(lat) || Number.isNaN(lng)) return res.status(400).json({ error: 'lat,lng required' });

  const results = db.jobs
    .filter(j => j.status === 'open')
    .map(j => ({ j, dist: haversineKm(lat, lng, j.lat, j.lng) }))
    .filter(({ j, dist }) => dist <= (radius || 5))
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 50)
    .map(({ j, dist }) => ({ ...j, distanceKm: Number(dist.toFixed(2)) }));

  res.json({ count: results.length, results });
});

// Invite a worker to a job (farmer)
app.post('/api/jobs/:jobId/invite/:workerId', authMiddleware, (req, res) => {
  const db = loadDB();
  const user = getUser(db, req.userId);
  if (user.role !== 'farmer') return res.status(400).json({ error: 'Not a farmer' });

  const job = db.jobs.find(j => j.id === req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.farmerId !== user.id) return res.status(403).json({ error: 'Not your job' });

  const worker = db.workers.find(w => w.userId === req.params.workerId);
  if (!worker) return res.status(404).json({ error: 'Worker not found' });

  const invite = { id: uuidv4(), jobId: job.id, workerId: worker.userId, status: 'invited', createdAt: new Date().toISOString() };
  db.invites.push(invite);
  saveDB(db);

  pushEvent(worker.userId, { type: 'invite', jobId: job.id, inviteId: invite.id, title: job.title, wage: job.wage });
  res.json({ invite });
});

// Accept an invite (worker)
app.post('/api/invites/:inviteId/accept', authMiddleware, (req, res) => {
  const db = loadDB();
  const invite = db.invites.find(i => i.id === req.params.inviteId);
  if (!invite) return res.status(404).json({ error: 'Invite not found' });
  const userId = req.userId;
  if (invite.workerId !== userId) return res.status(403).json({ error: 'Not your invite' });

  invite.status = 'accepted';
  saveDB(db);
  const job = db.jobs.find(j => j.id === invite.jobId);
  pushEvent(job.farmerId, { type: 'invite_response', inviteId: invite.id, status: 'accepted', workerId: userId });
  res.json({ invite });
});

// Simple SSE event stream for notifications
app.get('/api/events', (req, res) => {
  const token = req.query.token?.toString();
  if (!token || !tokens.has(token)) return res.status(401).end();
  const userId = tokens.get(token);

  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders?.();

  if (!sseClients.has(userId)) sseClients.set(userId, new Set());
  sseClients.get(userId).add(res);

  const interval = setInterval(() => {
    res.write(`event: ping\ndata: {}\n\n`);
  }, 25000);

  req.on('close', () => {
    clearInterval(interval);
    sseClients.get(userId)?.delete(res);
  });
});

function pushEvent(userId, payload) {
  const set = sseClients.get(userId);
  if (!set) return;
  const data = `data: ${JSON.stringify(payload)}\n\n`;
  set.forEach(res => res.write(data));
}

app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});

