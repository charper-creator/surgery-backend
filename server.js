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
// VERY SIMPLE in-memory "database" for MVP
const patients = []; 
// Each patient will look like:
// {
//   id, name, phone, dob, cptCode,
//   surgeryDate: "2025-12-01", // YYYY-MM-DD
//   createdAt: Date.now(),
//   messages: {
//     preopSent: boolean,
//     dailyStartSent: boolean
//   }
// }
function parseDateYmd(str) {
  // Expecting "YYYY-MM-DD"
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}

function daysFromSurgery(surgeryDateYmd, today = new Date()) {
  const surgery = parseDateYmd(surgeryDateYmd);
  const msPerDay = 24 * 60 * 60 * 1000;
  const diff = today.setHours(0,0,0,0) - surgery.setHours(0,0,0,0);
  return Math.floor(diff / msPerDay);
}

// Simple SMS message templates

function buildPreopSms(patient) {
  return (
    `Hi ${patient.name}, your upcoming surgery (CPT ${patient.cptCode}) ` +
    `is scheduled for ${patient.surgeryDate}. ` +
    `Before surgery, we can lower your risks by: ` +
    `• Stopping smoking if you smoke\n` +
    `• Keeping blood pressure/diabetes under control\n` +
    `• Staying active and walking daily\n\n` +
    `Your surgeon will review your plan in clinic.`
  );
}

function buildPod1Sms(patient) {
  return (
    `Hi ${patient.name}, this is your post-op day 1 check-in after ` +
    `CPT ${patient.cptCode}. Today we care most about: pain control, ` +
    `drinking fluids, walking a bit, and how your incision looks. ` +
    `Reply to the app link we sent if you have concerning symptoms.`
  );
}

function buildDailyFollowupSms(patient, dayNumber) {
  return (
    `Hi ${patient.name}, this is your day ${dayNumber} after surgery ` +
    `check-in reminder. Open your recovery app to log pain, temp, ` +
    `nausea, fluids, and bowel function. ` +
    `If you have fever, severe pain, or trouble breathing, call your ` +
    `surgeon or seek urgent care.`
  );
}
// POST /api/patients
// Body: { name, phone, dob, cptCode, surgeryDate: "YYYY-MM-DD" }
app.post("/api/patients", async (req, res) => {
  try {
    const { name, phone, dob, cptCode, surgeryDate } = req.body || {};

    if (!name || !phone || !cptCode || !surgeryDate) {
      return res.status(400).json({
        error: "Missing required fields: name, phone, cptCode, surgeryDate",
      });
    }

    const id = crypto.randomBytes(8).toString("hex");

    const patient = {
      id,
      name,
      phone,
      dob: dob || null,
      cptCode,
      surgeryDate, // "YYYY-MM-DD"
      createdAt: Date.now(),
      messages: {
        preopSent: false,
        dailyStartSent: false,
      },
    };

    // Store patient in-memory
    patients.push(patient);

    // 1) Immediately send pre-op optimization SMS
    const preopText = buildPreopSms(patient);

    await twilioClient.messages.create({
      from: TWILIO_FROM,
      to: patient.phone,
      body: preopText,
    });

    patient.messages.preopSent = true;

    // In a real system you might also generate + send an app link here.
    // For now we keep "pre-op optimization" as a plain SMS touchpoint.

    return res.json({
      ok: true,
      patient: { id: patient.id, name: patient.name, surgeryDate },
    });
  } catch (err) {
    console.error("Error creating patient or sending pre-op SMS", err);
    return res.status(500).json({ error: "Failed to create patient" });
  }
});
// POST /api/run-daily-sms
// Called once per day by a cron job or manually for MVP
app.post("/api/run-daily-sms", async (req, res) => {
  const today = new Date();
  const results = [];

  for (const patient of patients) {
    const day = daysFromSurgery(patient.surgeryDate, new Date(today));

    // Day >= 0: surgery date is today or in the past
    // We only care from POD1 to POD14
    if (day < 1 || day > 14) {
      continue;
    }

    try {
      if (day === 1) {
        // Step 3: POD1 special message
        const pod1Text = buildPod1Sms(patient);
        await twilioClient.messages.create({
          from: TWILIO_FROM,
          to: patient.phone,
          body: pod1Text,
        });
        results.push(`Sent POD1 SMS to ${patient.name}`);
      }

      // Step 4: daily text prompts days 1–14
      const dailyText = buildDailyFollowupSms(patient, day);
      await twilioClient.messages.create({
        from: TWILIO_FROM,
        to: patient.phone,
        body: dailyText,
      });
      results.push(`Sent daily day ${day} SMS to ${patient.name}`);
    } catch (err) {
      console.error("Error sending daily SMS", patient.name, err);
      results.push(`Failed for ${patient.name}: ${err.message}`);
    }
  }

  return res.json({ ok: true, results });
});

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
