// Google Gemini (@google/genai) for the AI assistant. The API key, model, on/off switch and
// per-school monthly quota are set by the super admin in Console → Settings → AI, and the
// key is stored encrypted in PlatformSettings.
import { ApiError, GoogleGenAI } from "@google/genai";
import env from "../../config/env.js";
import PlatformSettings from "../../models/PlatformSettings.js";
import AppError from "../../utils/AppError.js";
import { decrypt } from "../../utils/crypto.js";

export const DEFAULT_MODEL = "gemini-3.8-flash";

// Development only: AI_FAKE=1 answers with a scripted model (no Google calls, never in production)
const FAKE = !env.isProduction && process.env.AI_FAKE === "1";

let cache = null;
let cachedAt = 0;

/** { enabled, apiKey, model, monthlyQuota } — apiKey is null when not set or unreadable. */
export async function aiConfig() {
  if (cache && Date.now() - cachedAt < 60_000) return cache;
  const a = (await PlatformSettings.findOne({ key: "platform" }, { ai: 1 }).lean())?.ai ?? {};
  const apiKey = decrypt(a.apiKeyEnc) || (FAKE ? "fake" : null);
  cache = { enabled: Boolean(a.enabled && apiKey), apiKey, model: a.model || DEFAULT_MODEL, monthlyQuota: a.monthlyQuota ?? 300 };
  cachedAt = Date.now();
  return cache;
}
export const forgetAiConfig = () => {
  cache = null;
  clients.clear();
};

const clients = new Map();
/** A client for this key (the fake one in AI_FAKE mode). */
export function geminiClient(apiKey) {
  if (FAKE && apiKey === "fake") return fakeClient;
  if (!clients.has(apiKey)) clients.set(apiKey, new GoogleGenAI({ apiKey }));
  return clients.get(apiKey);
}

/** Turns a Gemini failure into a message a school (or the console) can act on. */
export function geminiError(err) {
  if (err instanceof AppError) return err;
  if (err?.name === "AbortError") return new AppError(499, "Stopped.", "AI_ABORTED");
  if (err instanceof ApiError) {
    if (err.status === 400 && /api key/i.test(err.message)) return new AppError(502, "The AI service rejected the API key. Ask EduFlow support to check it.", "AI_KEY_INVALID");
    if (err.status === 401 || err.status === 403) return new AppError(502, "The AI service rejected the API key. Ask EduFlow support to check it.", "AI_KEY_INVALID");
    if (err.status === 404) return new AppError(502, "The AI model set in the console doesn't exist. Ask EduFlow support to check it.", "AI_MODEL_INVALID");
    if (err.status === 429) return new AppError(503, "The AI service is busy right now. Try again in a minute.", "AI_BUSY");
    if (err.status >= 500) return new AppError(503, "The AI service is having trouble right now. Try again in a minute.", "AI_UNAVAILABLE");
    return new AppError(502, `The AI service couldn't answer (${err.message.slice(0, 160)}).`, "AI_FAILED");
  }
  return new AppError(503, "Couldn't reach the AI service. Try again in a minute.", "AI_UNREACHABLE");
}

/** A tiny request to check a key and model (Console → Save and check). */
export async function pingGemini({ apiKey, model }) {
  try {
    const r = await geminiClient(apiKey).models.generateContent({
      model,
      contents: "Reply with the word OK.",
      config: { maxOutputTokens: 20, abortSignal: AbortSignal.timeout(20_000) },
    });
    return { ok: true, reply: (r.text ?? "").trim().slice(0, 40) };
  } catch (err) {
    throw geminiError(err);
  }
}

// ---------------------------------------------------------------------------
// Fake model (AI_FAKE=1): calls one tool picked from keywords, then summarises its result.
// Enough to test the tool loop, streaming, quotas and logging end to end.
// ---------------------------------------------------------------------------

const FAKE_TOOLS = [
  [/fee|due|owe|baki|बाकी|फी/i, "fee_dues"],
  [/collect/i, "fee_collections"],
  [/absent|attendance|हाजिर|उपस्थित/i, "attendance_today"],
  [/test|result|marks|exam/i, "test_results"],
  [/top|rank|best/i, "leaderboard"],
  [/class|students/i, "list_classes"],
];

function fakeTurn({ contents, config }) {
  const last = contents.at(-1);
  const toolResult = last?.parts?.find((p) => p.functionResponse)?.functionResponse;
  const usage = { promptTokenCount: 120, candidatesTokenCount: 40, totalTokenCount: 160 };
  if (toolResult) {
    const body = JSON.stringify(toolResult.response).slice(0, 300);
    return { parts: [{ text: `**Test mode** — ${toolResult.name} returned:\n\n\`${body}\`` }], usage };
  }
  const question = last?.parts?.map((p) => p.text ?? "").join(" ") ?? "";
  const declared = (config?.tools?.[0]?.functionDeclarations ?? []).map((d) => d.name);
  // Changes: "1000 fees for Sara", "mark Sara absent", "note about Sara: …"
  const call = (name, args) => declared.includes(name) && { parts: [{ functionCall: { id: `fake-${Date.now()}`, name, args }, thoughtSignature: "fake-signature" }], usage };
  const fee = question.match(/(\d+)\s*(?:rs|rupees|₹)?\s*fees?\s+for\s+(.+?)\s*$/i);
  if (fee) return call("prepare_fee_payment", { student: fee[2], amountRupees: Number(fee[1]) }) || { parts: [{ text: "Fee tool not available for your role." }], usage };
  const whole = question.match(/class\s+(\w+?)(?:-(\w+))?\s+all\s+(present|absent)(?:\s+except\s+(.+))?$/i);
  if (whole) {
    const everyone = whole[3].toLowerCase();
    const exceptions = (whole[4] ?? "")
      .split(/,|\band\b/)
      .map((x) => x.trim())
      .filter(Boolean)
      .map((x) => {
        const m = x.match(/^(.+?)\s+(present|absent|late|leave)$/i);
        return m ? { student: m[1], status: m[2].toLowerCase() } : { student: x, status: everyone === "present" ? "absent" : "present" };
      });
    return call("prepare_class_attendance", { grade: whole[1], section: whole[2] ?? "", everyone, exceptions }) || { parts: [{ text: "Attendance tool not available for your role." }], usage };
  }
  const att = question.match(/mark\s+(.+?)\s+(present|absent|late|leave)/i);
  if (att) return call("prepare_attendance", { student: att[1], status: att[2].toLowerCase() }) || { parts: [{ text: "Attendance tool not available for your role." }], usage };
  const note = question.match(/note (?:for|about)\s+(.+?):\s*(.+)$/i);
  if (note) return call("prepare_student_note", { student: note[1], kind: "praise", text: note[2] }) || { parts: [{ text: "Notes not available." }], usage };
  const pick = FAKE_TOOLS.find(([re, name]) => re.test(question) && declared.includes(name))?.[1];
  if (pick) return { parts: [{ functionCall: { id: `fake-${Date.now()}`, name: pick, args: {} }, thoughtSignature: "fake-signature" }], usage };
  const replyIn = String(config?.systemInstruction ?? "").match(/Always reply in (\w+)/)?.[1];
  return { parts: [{ text: `Test mode reply to: “${question.slice(0, 120)}”.${replyIn ? ` [reply in ${replyIn}]` : ""} (AI_FAKE=1, no Google call was made.)` }], usage };
}

const asResponse = (parts, usage) => ({
  candidates: [{ content: { role: "model", parts } }],
  usageMetadata: usage,
  get text() {
    return parts.map((p) => p.text ?? "").join("");
  },
  get functionCalls() {
    const calls = parts.filter((p) => p.functionCall).map((p) => p.functionCall);
    return calls.length ? calls : undefined;
  },
});

const fakeClient = {
  models: {
    async generateContent(req) {
      // Per-student messages: one scripted message per student in the request
      // Daily summary: an empty AI answer, so the summary is written from the numbers
      if (req.config?.responseMimeType === "application/json" && String(req.contents).startsWith("SUMMARY_FACTS:")) {
        return asResponse([{ text: JSON.stringify({ headline: "Test mode summary.", items: [] }) }], { promptTokenCount: 300, candidatesTokenCount: 40 });
      }
      if (req.config?.responseMimeType === "application/json") {
        const students = JSON.parse(String(req.contents).split("STUDENTS_JSON: ")[1] ?? "[]");
        const out = students.map((st) => ({ id: st.id, text: `Dear ${st.guardian || "Parent"}, test message about ${st.name.split(" ")[0]}${st.fees ? ` (₹${st.fees.balance} due)` : ""}.` }));
        return asResponse([{ text: JSON.stringify(out) }], { promptTokenCount: 200, candidatesTokenCount: 30 * out.length });
      }
      const { parts, usage } = fakeTurn({ contents: typeof req.contents === "string" ? [{ role: "user", parts: [{ text: req.contents }] }] : req.contents, config: req.config });
      // Drafts: echo the instruction so tests can see what was asked
      return asResponse(parts.map((p) => (p.functionCall ? { text: "OK" } : p)), usage);
    },
    async generateContentStream(req) {
      const { parts, usage } = fakeTurn(req);
      const wait = (ms) => new Promise((r) => setTimeout(r, ms));
      return (async function* () {
        // Feels like the real thing: a pause to "think", then text in small pieces
        await wait(700);
        for (const p of parts) {
          if (p.text) {
            // Stream text in a few pieces, like the real API
            const words = p.text.split(/(?<= )/);
            for (let i = 0; i < words.length; i += 4) {
              yield asResponse([{ text: words.slice(i, i + 4).join("") }], undefined);
              await wait(90);
            }
          } else yield asResponse([p], undefined);
        }
        yield asResponse([], usage);
      })();
    },
  },
};
