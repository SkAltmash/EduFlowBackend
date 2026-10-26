import { z } from "zod";
import { MESSAGE_TYPES } from "../../models/WhatsAppConfig.js";
import { objectId } from "../auth/auth.validation.js";
import { day } from "../attendance/attendance.validation.js";

const month = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Month must be YYYY-MM");

// Which reference each message type needs
const refSchemas = {
  fee_receipt: z.object({ paymentId: objectId }),
  fee_reminder: z.object({ studentId: objectId }),
  absence: z.object({ studentId: objectId, date: day }),
  attendance_summary: z.object({ studentId: objectId, month }),
  exam_result: z.object({ examId: objectId, studentId: objectId }),
  progress_report: z.object({ studentId: objectId, month }),
};

const batch = z
  .object({
    type: z.enum(MESSAGE_TYPES),
    refs: z.array(z.record(z.string(), z.unknown())).min(1, "Choose at least one recipient").max(500, "At most 500 recipients at a time"),
    today: day.optional(),
  })
  .transform((v, ctx) => {
    const schema = refSchemas[v.type];
    const refs = [];
    for (const [i, ref] of v.refs.entries()) {
      const r = schema.safeParse(ref);
      if (!r.success) {
        ctx.addIssue({ code: "custom", path: ["refs", i], message: r.error.issues[0].message });
        return z.NEVER;
      }
      refs.push(r.data);
    }
    return { ...v, refs };
  });

export const prepareSchema = batch;
export const sendSchema = batch;

export const logOpenedSchema = z.object({
  type: z.enum(MESSAGE_TYPES),
  entries: z
    .array(z.object({ refKey: z.string().min(1).max(100), studentId: objectId.optional(), to: z.string().max(20).optional() }))
    .min(1)
    .max(500),
});

const template = z.object({
  name: z.string().trim().max(512).regex(/^[a-z0-9_]*$/, "Template names use lowercase letters, numbers and _").optional(),
  language: z.string().trim().max(15).regex(/^[a-z]{2,3}(_[A-Z]{2})?$/, "Language code like en, en_US or hi").optional(),
});

export const settingsSchema = z
  .object({
    mode: z.enum(["link", "api"]),
    defaultCountryCode: z.string().regex(/^\d{1,4}$/, "Country code like 91"),
    phoneNumberId: z.string().trim().regex(/^\d*$/, "Phone number ID is digits only").max(50),
    displayPhone: z.string().trim().max(30),
    // Write-only; "" removes it
    accessToken: z.string().trim().max(1000),
    templates: z.object(Object.fromEntries(MESSAGE_TYPES.map((t) => [t, template.optional()]))),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one setting");

export const testSchema = z.object({ to: z.string().trim().min(8, "Enter a phone number").max(20) });

export const historyQuery = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  type: z.enum([...MESSAGE_TYPES, "all"]).default("all"),
});
