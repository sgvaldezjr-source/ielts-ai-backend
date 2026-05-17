require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const OpenAI = require("openai");
const fs = require("fs");
const ffmpeg = require("fluent-ffmpeg");
const ffmpegPath = require("@ffmpeg-installer/ffmpeg").path;
const { createClient } = require("@supabase/supabase-js");
ffmpeg.setFfmpegPath(ffmpegPath);

// ─── SUPABASE ADMIN CLIENT ────────────────────────────────────────────────────
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// ─── FREE TIER USAGE MIDDLEWARE ───────────────────────────────────────────────
const FREE_LIMIT = 5;

async function checkAndIncrementUsage(userId, type) {
  const countCol = type === "writing" ? "writing_count" : "speaking_count";

  const { data: existing, error: fetchErr } = await supabaseAdmin
    .from("usage_tracking")
    .select("*")
    .eq("user_id", userId)
    .maybeSingle();

  if (fetchErr) throw new Error("Usage check failed");

  if (!existing) {
    await supabaseAdmin.from("usage_tracking").insert({
      user_id: userId,
      writing_count: type === "writing" ? 1 : 0,
      speaking_count: type === "speaking" ? 1 : 0,
    });
    return { allowed: true, count: 1 };
  }

  const currentCount = existing[countCol];

  if (currentCount >= FREE_LIMIT) {
    return { allowed: false, count: currentCount };
  }

  await supabaseAdmin
    .from("usage_tracking")
    .update({ [countCol]: currentCount + 1 })
    .eq("user_id", userId);

  return { allowed: true, count: currentCount + 1 };
}

async function usageMiddleware(type) {
  return async (req, res, next) => {
    const userId = req.headers["x-user-id"];
    if (!userId) return res.status(401).json({ error: "Missing user ID" });
    try {
      // Check if user is premium — skip limit if so
      const { data: subscriber } = await supabaseAdmin
        .from("subscribers")
        .select("is_premium")
        .eq("user_id", userId)
        .maybeSingle();

      if (subscriber?.is_premium) return next();

      const { allowed, count } = await checkAndIncrementUsage(userId, type);
      if (!allowed) {
        return res.status(403).json({
          error: "free_limit_reached",
          type,
          count,
          limit: FREE_LIMIT,
        });
      }
      next();
    } catch (err) {
      console.error("Usage middleware error:", err);
      return res.status(500).json({ error: "Usage check failed" });
    }
  };
}

const app = express();
const upload = multer({ dest: "uploads/" });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY.trim() });

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use(cors({
  origin: "*",
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Authorization", "x-api-key", "x-user-id"],
  credentials: false,
}));
app.options("*", (req, res) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type, Authorization, x-api-key, x-user-id");
  res.sendStatus(200);
});
app.use(express.json({ limit: "50mb" }));

// ─── HELPERS ──────────────────────────────────────────────────────────────────
async function callClaude(messages, maxTokens = 2000) {
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

    const inputPath = req.file.path;
    const outputPath = req.file.path + ".mp3";

    await new Promise((resolve, reject) => {
      ffmpeg(inputPath)
        .toFormat("mp3")
        .on("end", resolve)
        .on("error", reject)
        .save(outputPath);
    });

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(outputPath),
      model: "whisper-1",
      language: "en",
    });

    fs.unlinkSync(inputPath);
    fs.unlinkSync(outputPath);
    res.json({ transcript: transcription.text });
  } catch (err) {
    console.error("Transcription error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// ─── CLAUDE PROXY (writing analysis) ──────────────────────────────────────────
app.post("/analyse", await usageMiddleware("writing"), async (req, res) => {
  try {
    const data = await callClaude(req.body.messages);
    res.json(data);
  } catch (err) {
    console.error("Analysis error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ─── SPEAKING ANALYSIS - parallel IELTS scoring + pronunciation ───────────────
app.post("/analyse-speaking", await usageMiddleware("speaking"), async (req, res) => {
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
