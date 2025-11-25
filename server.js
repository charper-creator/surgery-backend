import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import crypto from "crypto";
import twilio from "twilio";
import OpenAI from "openai";

dotenv.config();

const app = express();
app.use(cors());
app.use(express.json());

// -------- OPENAI CLIENT ----------
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// -------- TWILIO CLIENT ----------
const twilioClient = twilio(
  process.env.TWILIO_ACCOUNT_SID,
  process.env.TWILIO_AUTH_TOKEN
);

const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
const APP_URL = process.env.APP_URL || "http://localhost:5173";

// --------- DEMO "DATABASE" ----------
const patients = [
  {
    id: "p1",
    name: "Alex Johnson",
    phone: "+15555550123", // replace with your own test number
    dob: "1985-04-12",
    loginToken: null,
    loginTokenExpiresAt: null
  }
];

function findPatientById(id) {
  return patients.find((p) => p.id === id);
}

function findPatientByToken(token) {
  const now = Date.now();
  return patients.find(
    (p) => p.loginToken === token && p.loginTokenExpiresAt > now
  );
}

// -------- SEND SMS MAGIC LINK -----------
app.post("/api/send-invite", async (req, res) => {
  const { patientId } = req.body;
  const patient = findPatientById(patientId);

  if (!patient) return res.status(404).json({ error: "Patient not found" });

  const token = crypto.randomBytes(24).toString("hex");
  patient.loginToken = token;
  patient.loginTokenExpiresAt = Date.now() + 24 * 60 * 60 * 1000;

  const url = `${APP_URL}/?token=${token}`;

  try {
    await twilioClient.messages.create({
      from: TWILIO_FROM,
      to: patient.phone,
      body: `Hi ${patient.name.split(" ")[0]}, tap this secure link to access your surgery recovery app: ${url}`
    });

    res.json({ ok: true });
  } catch (err) {
    console.error("SMS error:", err);
    res.status(500).json({ error: "Failed to send SMS" });
  }
});

// -------- PATIENT LOGIN (DOB CHECK) --------
app.post("/api/patient-login", (req, res) => {
  const { token, dob } = req.body;

  const patient = findPatientByToken(token);
  if (!patient) return res.status(401).json({ error: "Invalid or expired token" });

  if (!dob || String(dob).trim() !== patient.dob) {
    return res.status(401).json({ error: "DOB does not match" });
  }

  const sessionToken = crypto.randomBytes(24).toString("hex");

  res.json({
    ok: true,
    sessionToken,
    patient: {
      id: patient.id,
      name: patient.name
    }
  });
});

// -------- AI RECOVERY COACH ----------
app.post("/api/recovery-coach", async (req, res) => {
  try {
    const { messages, context } = req.body;

    const response = await openai.chat.completions.create({
      model: "gpt-4.1-mini",
      messages: [
        {
          role: "system",
          content: `
You are a post-surgical recovery assistant.
Ask helpful follow-up questions.
Highlight warning signs.
NEVER diagnose.
Tell users to contact their surgeon or ER if needed.
`
        },
        {
          role: "system",
          content: `Clinical context: ${JSON.stringify(context)}`
        },
        ...(messages || [])
      ]
    });

    res.json({ reply: response.choices[0].message.content });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "AI coach unavailable" });
  }
});

// ---------- START SERVER -----------
const PORT = process.env.PORT || 4000;
app.listen(PORT, () => console.log("Backend running on port", PORT));
