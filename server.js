require('dotenv').config();

const express = require('express');
const multer = require('multer');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const { randomUUID } = require('crypto');
const { spawn } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'storage', 'uploads');
const OUTPUT_DIR = path.join(ROOT, 'storage', 'clips');
const DATA_FILE = path.join(ROOT, 'storage', 'videos.json');

for (const dir of [UPLOAD_DIR, OUTPUT_DIR]) fs.mkdirSync(dir, { recursive: true });
if (!fs.existsSync(DATA_FILE)) fs.writeFileSync(DATA_FILE, '[]', 'utf8');

app.use(cors());
app.use(express.json({ limit: '1mb' }));
app.use(express.static(ROOT));

function readVideos() {
  try { return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); }
  catch { return []; }
}
function writeVideos(videos) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(videos, null, 2), 'utf8');
}

const allowedMime = new Set(['video/mp4', 'video/quicktime', 'video/webm', 'video/x-matroska']);
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '');
    cb(null, `${randomUUID()}${ext || '.video'}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 500 * 1024 * 1024 },
  fileFilter: (_req, file, cb) => {
    if (!allowedMime.has(file.mimetype)) return cb(new Error('Unsupported video type. Please use MP4, MOV, WebM or MKV.'));
    cb(null, true);
  }
});

app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'ClipGenius AI backend' }));

app.get('/api/videos', (_req, res) => {
  const videos = readVideos().map(({ id, originalName, size, uploadedAt, clips }) =>
    ({ id, originalName, size, uploadedAt, clips: clips || [] }));
  res.json({ videos });
});

app.post('/api/videos', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a video file first.' });
  const videos = readVideos();
  const video = {
    id: path.basename(req.file.filename, path.extname(req.file.filename)),
    originalName: path.basename(req.file.originalname),
    storedName: req.file.filename,
    size: req.file.size,
    uploadedAt: new Date().toISOString(),
    clips: []
  };
  videos.unshift(video);
  writeVideos(videos);
  res.status(201).json({
    message: 'Video uploaded successfully.',
    video: { id: video.id, originalName: video.originalName, size: video.size, uploadedAt: video.uploadedAt }
  });
});

// Basic time-range clipping (not AI highlight detection). Requires FFmpeg installed on the server.
app.post('/api/videos/:id/clips', (req, res) => {
  const start = Number(req.body.startSeconds);
  const duration = Number(req.body.durationSeconds);
  if (!Number.isFinite(start) || !Number.isFinite(duration) || start < 0 || duration <= 0 || duration > 180) {
    return res.status(400).json({ error: 'Provide startSeconds >= 0 and durationSeconds between 0 and 180.' });
  }

  const videos = readVideos();
  const video = videos.find(v => v.id === req.params.id);
  if (!video) return res.status(404).json({ error: 'Video not found.' });

  const inputPath = path.join(UPLOAD_DIR, video.storedName);
  if (!fs.existsSync(inputPath)) return res.status(404).json({ error: 'Original video file is missing.' });

  const clipId = randomUUID();
  const outputName = `${clipId}.mp4`;
  const outputPath = path.join(OUTPUT_DIR, outputName);

  const ffmpeg = spawn(process.env.FFMPEG_PATH || 'ffmpeg', [
    '-y', '-ss', String(start), '-i', inputPath, '-t', String(duration),
    '-vf', 'scale=1080:1920:force_original_aspect_ratio=decrease,pad=1080:1920:(ow-iw)/2:(oh-ih)/2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23',
    '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', outputPath
  ]);

  let errorText = '';
  ffmpeg.stderr.on('data', chunk => { errorText += chunk.toString(); });
  ffmpeg.on('error', err => res.status(500).json({ error: `Could not start FFmpeg: ${err.message}` }));
  ffmpeg.on('close', code => {
    if (res.headersSent) return;
    if (code !== 0) return res.status(500).json({ error: 'Clip rendering failed. Check that FFmpeg is installed.', detail: errorText.slice(-1200) });
    const clip = { id: clipId, filename: outputName, createdAt: new Date().toISOString(), startSeconds: start, durationSeconds: duration };
    video.clips = video.clips || [];
    video.clips.push(clip);
    writeVideos(videos);
    res.status(201).json({ message: 'Clip created.', clip: { ...clip, downloadUrl: `/api/clips/${outputName}` } });
  });
});

app.get('/api/clips/:filename', (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(OUTPUT_DIR, filename);
  if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Clip not found.' });
  res.download(filePath);
});

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Video is too large. Maximum upload size is 500 MB.' });
  }
  res.status(400).json({ error: err.message || 'Something went wrong.' });
});

app.listen(PORT, () => console.log(`ClipGenius AI is running at http://localhost:${PORT}`));
