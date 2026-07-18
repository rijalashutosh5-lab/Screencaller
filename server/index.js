require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');

const authRoutes = require('./routes/auth');
const formRoutes = require('./routes/forms');
const inviteRoutes = require('./routes/invite');
const audioRoutes = require('./routes/audio');

const app = express();
app.use(cors());
app.use(express.json());

app.use('/api/auth', authRoutes);
app.use('/api/forms', formRoutes);
app.use('/api/invite', inviteRoutes);
app.use('/api/audio', audioRoutes);

app.use(express.static(path.join(__dirname, '..', 'public')));

app.get('/health', (req, res) => res.json({ ok: true }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Voice screener running at http://localhost:${PORT}`);
});
