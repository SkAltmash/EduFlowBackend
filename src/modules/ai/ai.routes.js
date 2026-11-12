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
