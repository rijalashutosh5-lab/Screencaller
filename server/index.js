require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const { requireAuth, blockDemoWrites } = require('./auth');

const authRoutes = require('./routes/auth');
const meRoutes = require('./routes/me');
const projectRoutes = require('./routes/projects');
const formRoutes = require('./routes/forms');
const inviteRoutes = require('./routes/invite');
const audioRoutes = require('./routes/audio');
const exportRoutes = require('./routes/export');

const app = express();
app.use(cors());
app.use(express.json());

// Auth is applied here, at the mount points, rather than inside each router —
// so the whole access-control story reads in one place and a new router can't
// quietly ship unguarded. blockDemoWrites rejects every non-GET for a demo
// account, whatever the route.
app.use('/api/auth', authRoutes); // public: sign in
app.use('/api/invite', inviteRoutes); // public: respondents, gated by share code
app.use('/api/me', requireAuth, meRoutes);
app.use('/api/projects', requireAuth, blockDemoWrites, projectRoutes);
app.use('/api/forms', requireAuth, blockDemoWrites, formRoutes);
app.use('/api/audio', requireAuth, audioRoutes); // read-only
app.use('/api/export', requireAuth, exportRoutes); // read-only

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Voice screener running at http://localhost:${PORT}`);
});
