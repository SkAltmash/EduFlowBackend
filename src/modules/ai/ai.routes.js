// AI assistant: status, the school's opt-in, chat (Server-Sent Events) and drafts.
import { Router } from "express";
import { z } from "zod";
import { ROLES } from "../../models/Membership.js";
import { authenticate } from "../../middleware/authenticate.js";
import { authorize } from "../../middleware/authorize.js";
import { validateBody } from "../../middleware/validate.js";
import AppError from "../../utils/AppError.js";
import * as ai from "./ai.service.js";
import { cancelAction, confirmAction, getAction } from "./ai.actions.js";
import { dailySummary } from "./ai.summary.js";
import * as slides from "./ai.slides.js";
import { writeRemarks } from "./ai.remarks.js";

const router = Router();
const manage = authorize(ROLES.OWNER, ROLES.ADMIN);
const ctx = (req) => ({ ip: req.ip, userAgent: req.get("user-agent") });

const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");
const chatSchema = z.object({
  question: z.string().trim().min(1, "Type a question").max(1000, "Keep the question under 1000 characters"),
  // Continue a saved chat; without it a new chat starts
  chatId: objectId.optional(),
  // Reply language; "auto" follows the question
  language: z.enum(["auto", "en", "hi", "mr"]).optional().default("auto"),
});
const updateChatSchema = z
  .object({ title: z.string().trim().min(1, "Give the chat a name").max(100).optional(), pinned: z.boolean().optional() })
  .refine((d) => d.title !== undefined || d.pinned !== undefined, { message: "Nothing to change" });

const writeSchema = z.object({
  kind: z.enum(["notice", "whatsapp", "fee_reminder", "homework", "remark"]),
  language: z.enum(["en", "hi", "mr"]).optional(),
  tone: z.enum(["friendly", "formal", "firm"]).optional(),
  prompt: z.string().trim().max(1000).optional().default(""),
  draft: z.string().max(5000).optional(),
}).refine((d) => d.prompt || d.draft, { message: "Say what to write", path: ["prompt"] });

const messagesSchema = z
  .object({
    studentIds: z.array(objectId).min(1, "Choose students").max(40, "Up to 40 students at a time"),
    purpose: z.enum(["fees", "attendance", "progress", "custom"]),
    note: z.string().trim().max(500).optional().default(""),
    language: z.enum(["en", "hi", "mr"]).optional().default("en"),
  })
  .refine((d) => d.purpose !== "custom" || d.note, { message: "Say what the message is about", path: ["note"] });

router.use(authenticate);

// The dashboard's daily summary (cached for the day; ?refresh=1 at most every 20 minutes)
router.get("/summary", async (req, res) =>
  res.json(await dailySummary(req.user, { language: ["en", "hi", "mr"].includes(req.query.language) ? req.query.language : "en", refresh: req.query.refresh === "1" }))
);
router.get("/status", async (req, res) => res.json(await ai.status(req.user)));
router.put("/settings", manage, validateBody(z.object({ enabled: z.boolean() })), async (req, res) => res.json(await ai.updateSettings(req.user, ctx(req), req.body)));
router.get("/history", manage, async (req, res) => res.json(await ai.history(req.user, { limit: Number(req.query.limit) || 50 })));
router.param("chatId", (req, res, next, value) => {
  if (!objectId.safeParse(value).success) throw AppError.badRequest("Invalid chat id", "INVALID_ID");
  next();
});
router.get("/chats", async (req, res) => res.json(await ai.listChats(req.user, { q: typeof req.query.q === "string" ? req.query.q.slice(0, 100) : undefined })));
router.delete("/chats", async (req, res) => res.json(await ai.deleteAllChats(req.user)));
router.get("/chats/:chatId", async (req, res) => res.json(await ai.getChat(req.user, req.params.chatId)));
router.patch("/chats/:chatId", validateBody(updateChatSchema), async (req, res) => res.json(await ai.updateChat(req.user, req.params.chatId, req.body)));
router.delete("/chats/:chatId", async (req, res) => res.json(await ai.deleteChat(req.user, req.params.chatId)));
// Prepared changes: the member picks the student and confirms (fields are checked per kind)
router.param("actionId", (req, res, next, value) => {
  if (!objectId.safeParse(value).success) throw AppError.badRequest("Invalid action id", "INVALID_ID");
  next();
});
const confirmSchema = z.object({
  // Not used for whole-class attendance (entries instead)
  studentId: objectId.optional(),
  entries: z.array(z.object({ studentId: objectId, status: z.string().max(20) })).max(500).optional(),
  amount: z.number().optional(),
  mode: z.string().max(20).optional(),
  date: z.string().max(10).optional(),
  note: z.string().max(500).optional(),
  status: z.string().max(20).optional(),
  kind: z.string().max(20).optional(),
  text: z.string().max(1000).optional(),
});
router.get("/actions/:actionId", async (req, res) => res.json(await getAction(req.user, req.params.actionId)));
router.post("/actions/:actionId/confirm", validateBody(confirmSchema), async (req, res) => res.json(await confirmAction(req.user, ctx(req), req.params.actionId, req.body)));
router.post("/actions/:actionId/cancel", async (req, res) => res.json(await cancelAction(req.user, req.params.actionId)));
// Presentations
const lang = z.enum(["en", "hi", "mr"]).optional().default("en");
const outlineSchema = z.object({
  topic: z.string().trim().min(3, "Say what the presentation is about").max(300),
  audience: z.string().trim().max(120).optional().default(""),
  slides: z.coerce.number().int().min(5).max(15).optional().default(10),
  language: lang,
});
const deckSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("topic"),
    topic: z.string().trim().min(3).max(300),
    audience: z.string().trim().max(120).optional().default(""),
    language: lang,
    theme: z.enum(slides.DECK_THEMES).optional(),
    pictures: z.boolean().optional(),
    outline: z.object({
      title: z.string().trim().max(140),
      slides: z.array(z.object({ title: z.string().trim().min(1).max(140), points: z.array(z.string().max(120)).max(4).optional().default([]) })).min(2).max(15),
    }),
  }),
  z.object({ kind: z.literal("class_results"), examId: objectId, showNames: z.boolean().optional().default(true), language: lang, theme: z.enum(slides.DECK_THEMES).optional() }),
  z.object({ kind: z.literal("monthly_review"), month: z.string().regex(/^\d{4}-\d{2}$/, "Choose a month"), language: lang, theme: z.enum(slides.DECK_THEMES).optional() }),
]);
const updateDeckSchema = z
  .object({ title: z.string().trim().min(1).max(140).optional(), theme: z.enum(slides.DECK_THEMES).optional(), slides: z.array(z.record(z.string(), z.unknown())).min(1).max(20).optional() })
  .refine((d) => d.title !== undefined || d.theme !== undefined || d.slides !== undefined, { message: "Nothing to change" });
router.param("deckId", (req, res, next, value) => {
  if (!objectId.safeParse(value).success) throw AppError.badRequest("Invalid presentation id", "INVALID_ID");
  next();
});
router.get("/decks", async (req, res) => res.json(await slides.listDecks(req.user)));
router.get("/decks/sources", async (req, res) => res.json(await slides.deckSources(req.user)));
router.post("/decks/outline", validateBody(outlineSchema), async (req, res) => res.json(await slides.outline(req.user, req.body)));
router.post("/decks", validateBody(deckSchema), async (req, res) => res.status(201).json(await slides.createDeck(req.user, req.body)));
router.get("/decks/:deckId", async (req, res) => res.json(await slides.getDeck(req.user, req.params.deckId)));
router.patch("/decks/:deckId", validateBody(updateDeckSchema), async (req, res) => res.json(await slides.updateDeck(req.user, req.params.deckId, req.body)));
router.delete("/decks/:deckId", async (req, res) => res.json(await slides.deleteDeck(req.user, req.params.deckId)));
router.post("/decks/:deckId/slides", validateBody(z.object({ after: z.coerce.number().int().min(0).max(19), instruction: z.string().trim().min(3, "Say what the slide should be").max(300) })), async (req, res) =>
  res.status(201).json(await slides.insertSlide(req.user, req.params.deckId, req.body))
);
router.post("/decks/images/signature", async (req, res) => res.json(await slides.imageUploadSignature(req.user)));
router.post("/decks/:deckId/slides/:index/image", validateBody(z.object({ prompt: z.string().trim().max(300).optional().default("") })), async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= 20) throw AppError.badRequest("Invalid slide", "INVALID_ID");
  res.json(await slides.generateSlideImage(req.user, req.params.deckId, index, req.body));
});
router.post("/remarks", authorize(ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER), validateBody(z.object({ examId: objectId, language: z.enum(["en", "hi", "mr"]).optional().default("en"), tone: z.enum(["warm", "formal", "brief"]).optional().default("warm") })), async (req, res) =>
  res.json(await writeRemarks(req.user, req.body))
);
router.post("/decks/:deckId/translate", validateBody(z.object({ language: z.enum(["en", "hi", "mr"]) })), async (req, res) => res.json(await slides.translateDeck(req.user, req.params.deckId, req.body)));
router.post("/decks/:deckId/slides/:index/regenerate", validateBody(z.object({ instruction: z.string().trim().max(300).optional().default("") })), async (req, res) => {
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= 20) throw AppError.badRequest("Invalid slide", "INVALID_ID");
  res.json(await slides.regenerateSlide(req.user, req.params.deckId, index, req.body));
});
router.post("/messages", validateBody(messagesSchema), async (req, res) => res.json(await ai.suggestMessages(req.user, { ...req.body, studentIds: [...new Set(req.body.studentIds)] })));
router.post("/write", validateBody(writeSchema), async (req, res) => res.json(await ai.write(req.user, req.body)));

// Streams: event "start" | "tool" | "action" | "text" | "chat" | "done" | "error", each with a JSON data line.
// Problems found before streaming starts (not on the plan, quota…) are normal JSON errors.
router.post("/chat", validateBody(chatSchema), async (req, res) => {
  const controller = new AbortController();
  res.on("close", () => controller.abort());
  let started = false;
  const send = (event, data) => {
    if (!started) {
      res.status(200).set({ "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", "X-Accel-Buffering": "no", Connection: "keep-alive" });
      res.flushHeaders();
      started = true;
    }
    if (!res.writableEnded) res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  try {
    // Opens the stream right away so the browser can show "Thinking…"
    await ai.chat(req.user, req.body, (event, data) => send(event, data), controller.signal, () => send("start", {}));
  } finally {
    if (started) res.end();
  }
});

export default router;
