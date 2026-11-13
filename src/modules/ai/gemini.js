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
  cache = { enabled: Boolean(a.enabled && apiKey), apiKey, model: a.model || DEFAULT_MODEL, monthlyQuota: a.monthlyQuota ?? 300, thinking: a.thinking || "low", ...imageSettings(a), imagePriceUsd: a.imagePriceUsd ?? 0.04 };
  if (!cache.imageModel && FAKE && apiKey === "fake") cache.imageModel = "fake-image";
  cachedAt = Date.now();
  return cache;
}
/** True when AI pictures can be made with these settings. */
export const imagesReady = (c) => c.imageModel === "fake-image" || Boolean(c.imageModel && (c.imageProvider !== "cloudflare" || (c.cfAccountId && c.cfToken)));

/** The image half of the AI settings: { imageProvider, imageModel, cfAccountId, cfToken }. */
export function imageSettings(a) {
  return { imageProvider: a.imageProvider || "cloudflare", imageModel: a.imageModel || "", cfAccountId: a.cfAccountId || "", cfToken: decrypt(a.cfTokenEnc) || null };
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

// Models that rejected a thinking level: asked again without it, and not sent it again
const noThinkingLevel = new Set();
const THINKING_LEVEL = { minimal: "MINIMAL", low: "LOW" };

/** The request config with the console's thinking setting (less thinking answers faster). */
function withThinking(cfg, config, level = cfg.thinking) {
  if (!THINKING_LEVEL[level] || noThinkingLevel.has(cfg.model)) return config;
  return { ...config, thinkingConfig: { ...(config.thinkingConfig ?? {}), thinkingLevel: THINKING_LEVEL[level] } };
}
const rejectsThinking = (err) => err instanceof ApiError && err.status === 400 && /think/i.test(err.message);

/** generateContent with the thinking setting; retried once without it if the model doesn't support it. */
// Google's "overloaded" and other passing errors: asked again after a short wait
const TRANSIENT = new Set([429, 500, 502, 503, 504]);
const RETRY_WAITS = [1500, 4000];

/** Runs a Gemini request, retrying twice on a passing server error (not once it was stopped). */
async function withRetry(run, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await run();
    } catch (err) {
      const wait = RETRY_WAITS[attempt];
      if (!(err instanceof ApiError && TRANSIENT.has(err.status)) || wait === undefined || signal?.aborted) throw err;
      console.warn(`Gemini ${err.status} (${String(err.message).slice(0, 120)}); trying again in ${wait / 1000}s`);
      await new Promise((r) => setTimeout(r, wait));
    }
  }
}

export async function generate(cfg, { config, ...req }, level) {
  const client = geminiClient(cfg.apiKey);
  try {
    return await withRetry(() => client.models.generateContent({ model: cfg.model, ...req, config: withThinking(cfg, config, level) }), config?.abortSignal);
  } catch (err) {
    if (!rejectsThinking(err) || noThinkingLevel.has(cfg.model)) throw err;
    noThinkingLevel.add(cfg.model);
    console.warn(`Gemini model ${cfg.model} doesn't take a thinking level; asking without it.`);
    return client.models.generateContent({ model: cfg.model, ...req, config });
  }
}

/** generateContentStream, the same way. */
export async function generateStream(cfg, { config, ...req }, level) {
  const client = geminiClient(cfg.apiKey);
  try {
    return await withRetry(() => client.models.generateContentStream({ model: cfg.model, ...req, config: withThinking(cfg, config, level) }), config?.abortSignal);
  } catch (err) {
    if (!rejectsThinking(err) || noThinkingLevel.has(cfg.model)) throw err;
    noThinkingLevel.add(cfg.model);
    console.warn(`Gemini model ${cfg.model} doesn't take a thinking level; asking without it.`);
    return client.models.generateContentStream({ model: cfg.model, ...req, config });
  }
}

/** Turns a Gemini failure into a message a school (or the console) can act on. */
export function geminiError(err) {
  if (err instanceof AppError) return err;
  if (err?.name === "AbortError") return new AppError(499, "Stopped.", "AI_ABORTED");
  if (err instanceof ApiError) {
    console.error(`Gemini error ${err.status}: ${String(err.message).slice(0, 400)}`);
    if (err.status === 400 && /api key/i.test(err.message)) return new AppError(502, "The AI service rejected the API key. Ask EduFlow support to check it.", "AI_KEY_INVALID");
    if (err.status === 401 || err.status === 403) return new AppError(502, "The AI service rejected the API key. Ask EduFlow support to check it.", "AI_KEY_INVALID");
    if (err.status === 404) return new AppError(502, "The AI model set in the console doesn't exist. Ask EduFlow support to check it.", "AI_MODEL_INVALID");
    if (err.status === 429) return new AppError(503, "The AI service is busy right now. Try again in a minute.", "AI_BUSY");
    if (err.status >= 500) return new AppError(503, "The AI service is having trouble right now. Try again in a minute.", "AI_UNAVAILABLE");
    return new AppError(502, `The AI service couldn't answer (${err.message.slice(0, 160)}).`, "AI_FAILED");
  }
  return new AppError(503, "Couldn't reach the AI service. Try again in a minute.", "AI_UNREACHABLE");
}

// Test mode: a 1×1 picture
const FAKE_PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==";

export const CF_DEFAULT_IMAGE_MODEL = "@cf/black-forest-labs/flux-1-schnell";

/**
 * Makes one picture with the console's image settings. Returns { data (base64), mimeType }, or
 * null when the model answered without a picture (a blocked prompt).
 * - Cloudflare Workers AI (FLUX schnell): free up to a daily allowance; square pictures.
 * - Gemini image models ("gemini-…-image"): the picture comes back as inline data. (Imagen's
 *   generateImages only works on Vertex AI, not with an AI Studio key, and is deprecated.)
 */
export async function makeImage(cfg, prompt, { aspectRatio = "4:3" } = {}) {
  if (cfg.imageModel === "fake-image") return { data: FAKE_PNG, mimeType: "image/png" };
  if (cfg.imageProvider === "cloudflare") return cloudflareImage(cfg, prompt);
  if (/^imagen/i.test(cfg.imageModel)) throw AppError.badRequest("Imagen models need Vertex AI. In the console, use a Gemini image model such as gemini-2.5-flash-image.", "AI_IMAGE_MODEL");
  try {
    const r = await geminiClient(cfg.apiKey).models.generateContent({
      model: cfg.imageModel,
      contents: prompt,
      config: { responseModalities: ["IMAGE"], imageConfig: { aspectRatio }, abortSignal: AbortSignal.timeout(90_000) },
    });
    const part = r.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
    return part ? { data: part.inlineData.data, mimeType: part.inlineData.mimeType || "image/png" } : null;
  } catch (err) {
    throw geminiError(err);
  }
}

async function cloudflareImage(cfg, prompt) {
  if (!cfg.cfAccountId || !cfg.cfToken) throw AppError.badRequest("AI pictures need the Cloudflare account ID and API token (Console → Settings → AI).", "AI_IMAGES_OFF");
  const model = cfg.imageModel?.startsWith("@cf/") ? cfg.imageModel : CF_DEFAULT_IMAGE_MODEL;
  let res;
  try {
    res = await fetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(cfg.cfAccountId)}/ai/run/${model}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${cfg.cfToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: prompt.slice(0, 2000), steps: 4 }),
      signal: AbortSignal.timeout(60_000),
    });
  } catch (err) {
    if (err?.name === "TimeoutError") throw new AppError(504, "The picture took too long. Try again.", "AI_TIMEOUT");
    throw new AppError(503, "Couldn't reach Cloudflare to make the picture. Try again in a minute.", "AI_UNREACHABLE");
  }
  const body = await res.json().catch(() => null);
  const image = body?.result?.image;
  if (res.ok && image) return { data: image, mimeType: "image/jpeg" };
  const why = (body?.errors ?? []).map((e) => `${e.code ?? ""} ${e.message ?? ""}`).join("; ");
  if (res.status === 401 || res.status === 403 || /auth/i.test(why)) throw new AppError(502, "Cloudflare refused the API token. Check the account ID and that the token has Workers AI permission.", "AI_IMAGE_AUTH");
  if (res.status === 429 || /allocation|neurons|limit/i.test(why)) throw new AppError(429, "Today's free AI pictures are used up. Try again tomorrow, or upload a picture.", "AI_IMAGE_LIMIT");
  if (res.status === 404 || /no such model|not found/i.test(why)) throw new AppError(502, "The Cloudflare image model set in the console doesn't exist.", "AI_IMAGE_MODEL");
  if (res.ok || res.status === 400) return null; // blocked or empty
  throw new AppError(502, `Cloudflare couldn't make the picture (${res.status}). Try again.`, "AI_IMAGE_FAILED");
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
    return { parts: [{ text: `**Test mode** — ${toolResult.name} returned:\n\n\`${body}\`\nFOLLOWUPS: Who is absent today? | Which class has the most overdue fees? | Top 5 students this month` }], usage };
  }
  const question = last?.parts?.map((p) => p.text ?? "").join(" ") ?? "";
  const declared = (config?.tools?.[0]?.functionDeclarations ?? []).map((d) => d.name);
  // Changes: "1000 fees for Sara", "mark Sara absent", "note about Sara: …"
  const call = (name, args) => declared.includes(name) && { parts: [{ functionCall: { id: `fake-${Date.now()}`, name, args }, thoughtSignature: "fake-signature" }], usage };
  const fee = question.match(/(\d+)\s*(?:rs|rupees|₹)?\s*fees?\s+for\s+(.+?)\s*$/i);
  if (fee) return call("prepare_fee_payment", { student: fee[2], amountRupees: Number(fee[1]) }) || { parts: [{ text: "Fee tool not available for your role." }], usage };
  const howTo = question.match(/^how (?:do i|to)\s+(.+)$/i);
  if (howTo) return call("how_to", { topic: howTo[1] }) || { parts: [{ text: "Help not available." }], usage };
  const receipts = question.match(/receipts?\s+(?:for|of)\s+(.+?)\s*$/i);
  if (receipts) return call("student_receipts", { student: receipts[1] }) || { parts: [{ text: "Receipts not available for your role." }], usage };
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
  return { parts: [{ text: `Test mode reply to: “${question.slice(0, 120)}”.${replyIn ? ` [reply in ${replyIn}]` : ""} (AI_FAKE=1, no Google call was made.)\n**Follow-ups:** How much fee did we collect this month? | Who is absent today?` }], usage };
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

// Test mode: the model name "gemini-no-thinking" rejects a thinking level, like an older model
function fakeThinkingCheck(req) {
  if (req.model === "gemini-no-thinking" && req.config?.thinkingConfig?.thinkingLevel) {
    throw new ApiError({ message: "Thinking level is not supported for this model.", status: 400 });
  }
  fakeThinkingCheck.lastLevel = req.config?.thinkingConfig?.thinkingLevel ?? null;
}
export const fakeLastThinkingLevel = () => fakeThinkingCheck.lastLevel;

const fakeClient = {
  models: {
    async generateContent(req) {
      fakeThinkingCheck(req);
      // Per-student messages: one scripted message per student in the request
      // Presentations: scripted outline, slides and captions in the requested shapes
      const deck = String(req.contents).match(/^DECK_(OUTLINE|TOPIC|DATA|SLIDE|NEW|TRANSLATE): ([\s\S]*)$/);
      if (req.config?.responseMimeType === "application/json" && deck) {
        const input = JSON.parse(deck[2]);
        let out;
        if (deck[1] === "OUTLINE") out = { title: `About ${input.topic}`, slides: Array.from({ length: input.slides }, (_, i) => ({ title: i === 0 ? input.topic : i === input.slides - 1 ? "Thank you" : `Part ${i}: ${input.topic}`, points: [`Point A ${i}`, `Point B ${i}`] })) };
        else if (deck[1] === "TOPIC") {
          const n = input.outline.slides.length;
          out = { slides: input.outline.slides.map((s, i) => (i === 0 ? { layout: "title", title: s.title, notes: "Welcome everyone." } : i === n - 1 ? { layout: "closing", title: s.title, notes: "Thanks." } : i === 1 ? { layout: "image", title: s.title, bullets: ["Picture point"], imagePrompt: `A picture about ${s.title}`, notes: "Look at this." } : i % 3 === 2 ? { layout: "two_column", title: s.title, left: { heading: "Before", bullets: ["One", "Two"] }, right: { heading: "After", bullets: ["Three", "Four"] }, notes: "Compare." } : { layout: "bullets", title: s.title, bullets: s.points.length ? s.points : ["Test point"], notes: `Talk about ${s.title}.` })) };
        } else if (deck[1] === "DATA") out = { title: "Test mode deck", subtitle: "Made from records", dataSlides: input.dataSlides.map((d) => ({ id: d.id, caption: `Test caption for ${d.id}.`, notes: `Notes for ${d.id}.` })), extraSlides: [{ layout: "bullets", title: "Highlights", bullets: ["Good attendance", "Fees on track"], notes: "Highlights." }, { layout: "closing", title: "Thank you" }] };
        else if (deck[1] === "NEW") out = { layout: "bullets", title: `New: ${input.instruction}`, bullets: ["First idea", "Second idea"], notes: "Added by AI." };
        else if (deck[1] === "TRANSLATE") {
          // Test mode "translation": a marker in front of every text
          const tr = (v) => (typeof v === "string" && v ? `[T] ${v}` : Array.isArray(v) ? v.map(tr) : v);
          out = { title: tr(input.title), items: input.items.map((it) => Object.fromEntries(Object.entries(it).map(([k, v]) => [k, k === "i" ? v : tr(v)]))) };
        } else out = { ...input, title: `Improved: ${input.title}`, caption: "A clearer caption.", notes: "Better notes." };
        return asResponse([{ text: JSON.stringify(out) }], { promptTokenCount: 500, candidatesTokenCount: 400 });
      }
      // Report-card remarks: one per student
      if (req.config?.responseMimeType === "application/json" && String(req.contents).startsWith("REMARKS_JSON:")) {
        const list = JSON.parse(String(req.contents).slice("REMARKS_JSON:".length));
        return asResponse([{ text: JSON.stringify(list.map((st) => ({ id: st.id, remark: `${st.firstName} did well${st.subjects[0] ? ` in ${st.subjects[0].subject}` : ""}. Keep it up! (test)` }))) }], { promptTokenCount: 300, candidatesTokenCount: 20 * list.length });
      }
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
      fakeThinkingCheck(req);
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
