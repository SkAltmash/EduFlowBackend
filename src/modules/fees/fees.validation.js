import { z } from "zod";
import { concessionSchema } from "./fees.concessions.js";
import { PAYMENT_MODES } from "../../models/Payment.js";
import { objectId } from "../auth/auth.validation.js";
import { day } from "../attendance/attendance.validation.js";

// Amounts are integers in paise; ₹10 crore is a generous upper bound for one figure
const MAX_AMOUNT = 1_000_000_000;
const money = (label) =>
  z
    .number({ error: `${label} must be a number` })
    .int(`${label} must be in whole paise`)
    .min(0, `${label} can't be negative`)
    .max(MAX_AMOUNT, `${label} is too large`);

const feeItem = z.object({
  name: z.string().trim().min(1, "Fee item name is required").max(100),
  amount: money("Amount"),
});

const installment = z.object({
  // Present when editing an existing installment, so its dues stay linked
  _id: objectId.optional(),
  label: z.string().trim().min(1, "Installment label is required").max(100),
  dueDate: day,
  items: z.array(feeItem).min(1, "Each installment needs at least one fee item").max(30),
});

const planFields = {
  name: z.string().trim().min(2, "Plan name must be at least 2 characters").max(150),
  academicYear: z.string().trim().max(20),
  grade: z.string().trim().max(50),
  description: z.string().trim().max(500),
  installments: z
    .array(installment)
    .min(1, "Add at least one installment")
    .max(60, "At most 60 installments")
    .refine((list) => list.some((i) => i.items.some((it) => it.amount > 0)), "The plan has no amounts"),
};

// Defaults only when creating: on a partial update a default would overwrite saved values
export const createPlanSchema = z.object({
  ...planFields,
  academicYear: planFields.academicYear.default(""),
  grade: planFields.grade.default(""),
  description: planFields.description.default(""),
});

export const updatePlanSchema = z
  .object({ ...planFields, archived: z.boolean() })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const assignPlanSchema = z
  .object({
    // Either a whole class (grade + optional section) or explicit students
    grade: z.string().trim().max(50).optional(),
    section: z.string().trim().max(20).optional(),
    studentIds: z.array(objectId).max(2000).optional(),
    // Class-wide concession for students without their own
    concession: concessionSchema.optional(),
    // Per-student choices from the assign screen (null = none for this student)
    concessions: z.array(z.object({ studentId: objectId, concession: concessionSchema.nullable() })).max(2000).default([]),
    // Save the per-student choices on the students for later plans
    remember: z.boolean().default(false),
  })
  .refine((v) => Boolean(v.grade) !== Boolean(v.studentIds?.length), "Choose a class or a list of students, not both");

export const updateInvoiceSchema = z
  .object({
    discount: money("Discount").optional(),
    discountReason: z.string().trim().max(200).optional(),
    dueDate: day.optional(),
  })
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

export const createPaymentSchema = z.object({
  studentId: objectId,
  amount: money("Amount").min(1, "Amount must be more than zero"),
  date: day,
  mode: z.enum(PAYMENT_MODES, { error: `Mode must be one of: ${PAYMENT_MODES.join(", ")}` }),
  reference: z.string().trim().max(100).default(""),
  note: z.string().trim().max(500).default(""),
  // Omit to apply the payment to the oldest dues first
  allocations: z
    .array(z.object({ invoiceId: objectId, amount: money("Allocation").min(1) }))
    .min(1)
    .max(100)
    .refine((a) => new Set(a.map((x) => x.invoiceId)).size === a.length, "Each due can appear only once")
    .optional(),
});

export const voidPaymentSchema = z.object({
  reason: z.string().trim().min(3, "Give a reason (at least 3 characters)").max(200),
});

const pagination = {
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(25),
};

export const listPlansQuery = z.object({ archived: z.enum(["true", "false", "all"]).default("false") });

export const registerQuery = z.object({
  ...pagination,
  search: z.string().trim().max(100).optional(),
  grade: z.string().trim().max(50).optional(),
  section: z.string().trim().max(20).optional(),
  // overdue: has a past-due balance; due: any balance; paid: nothing outstanding; none: no fees assigned
  status: z.enum(["all", "overdue", "due", "paid", "none"]).default("all"),
  sort: z.enum(["name", "balance", "overdue", "grade"]).default("name"),
  today: day.optional(),
});

export const listPaymentsQuery = z.object({
  ...pagination,
  from: day.optional(),
  to: day.optional(),
  mode: z.enum([...PAYMENT_MODES, "all"]).default("all"),
  search: z.string().trim().max(100).optional(),
  includeVoided: z.enum(["true", "false"]).default("true"),
});

export const exportPaymentsQuery = listPaymentsQuery.omit({ page: true, limit: true });

export const summaryQuery = z
  .object({ from: day, to: day, today: day.optional() })
  .refine((v) => v.from <= v.to, { message: "`from` must be on or before `to`", path: ["from"] });

export const studentLedgerQuery = z.object({ today: day.optional() });

export const idParamSchema = objectId;
