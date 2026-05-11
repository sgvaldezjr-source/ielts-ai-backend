require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs");

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key"],
  credentials: false,
}));
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key");
  res.sendStatus(200);
});
app.use(express.json({ limit: "50mb" }));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function callClaude(messages, maxTokens = 1500) {
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": process.env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5-20251001",
      max_tokens: maxTokens,
      messages,
    }),
  });
  return response.json();
}

function buildPronunciationPrompt(part, question, transcript) {
  return `You are an expert IELTS Speaking examiner specialising in pronunciation assessment for non-native English speakers.

Analyse this IELTS Speaking Part ${part} transcript for pronunciation, fluency and prosody. Base your assessment on common pronunciation patterns for non-native speakers and evidence in the text itself.

QUESTION: ${question}
TRANSCRIPT: ${transcript}

Assess these four areas:
1. Individual sounds - likely problem consonants and vowels based on word choices and common L1 interference patterns
2. Word stress - correct stress placement on key words
3. Sentence stress and rhythm - natural prominence on content words
4. Intonation and fluency - use of fillers, hesitation markers, sentence rhythm

Return ONLY this JSON - no markdown, no apostrophes in strings:
{
  "pronunciation_band": <number 1-9>,
  "overall_score": <number 0-100>,
  "fluency_score": <number 0-100>,
  "stress_score": <number 0-100>,
  "intonation_score": <number 0-100>,
  "summary": "<2 sentences overall pronunciation assessment>",
  "strengths": "<one specific pronunciation strength with example from transcript>",
  "problem_words": [
    { "word": "<exact word from transcript>", "issue": "<brief description of likely pronunciation issue>", "tip": "<one concrete improvement tip>" },
    { "word": "<word>", "issue": "<issue>", "tip": "<tip>" },
    { "word": "<word>", "issue": "<issue>", "tip": "<tip>" }
  ],
  "fluency_comment": "<one sentence on pace, rhythm and hesitation patterns>",
  "intonation_comment": "<one sentence on intonation and stress patterns>",
  "next_steps": "<two specific pronunciation exercises or habits to practise>"
}`;
}

// ─── HEALTH CHECK ─────────────────────────────────────────────────────────────
app.get("/", (req, res) => {
  res.json({ status: "SoundReady Ascend Backend running" });
});

// ─── WHISPER TRANSCRIPTION ────────────────────────────────────────────────────
app.post("/transcribe", upload.single("audio"), async (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ error: "No audio file provided" });
    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(req.file.path),
      model: "whisper-1",
      language: "en",
    });
    fs.unlinkSync(req.file.path);
    res.json({ transcript: transcription.text });
  } catch (err) {
    console.error("Transcription error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── CLAUDE PROXY (writing analysis) ──────────────────────────────────────────
app.post("/analyse", async (req, res) => {
  try {
    const data = await callClaude(req.body.messages);
    res.json(data);
  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SPEAKING ANALYSIS - parallel IELTS scoring + pronunciation ───────────────
app.post("/analyse-speaking", async (req, res) => {
  try {
    const { ieltsMessages, part, question, transcript } = req.body;

    const [ieltsResult, pronResult] = await Promise.all([
      callClaude(ieltsMessages, 1500),
      callClaude([{ role: "user", content: buildPronunciationPrompt(part, question, transcript) }], 800),
    ]);

    res.json({
      ielts: ieltsResult,
      pronunciation: pronResult,
    });
  } catch (err) {
    console.error("Speaking analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── START SERVER ─────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`SoundReady Ascend Backend running on port ${PORT}`);
});
