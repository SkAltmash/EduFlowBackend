import { z } from "zod";
import { email, objectId, strongPassword } from "../auth/auth.validation.js";
import { ROLES } from "../../models/Membership.js";

export const idParamSchema = objectId;

const optionalText = (max) => z.string().trim().max(max);

// Every field optional: the page sends only what changed
export const updateSchoolSchema = z
  .object({
    name: z.string().trim().min(2, "School name must be at least 2 characters").max(150),
    type: z.enum(["school", "tuition", "coaching", "other"]),
    board: optionalText(60),
    phone: optionalText(30).regex(/^[\d\s+()-]*$/, "Phone can only contain digits, spaces and + - ( )"),
    email: z.union([z.literal(""), email]),
    website: optionalText(200),
    address: optionalText(300),
    city: optionalText(80),
    state: optionalText(80),
    pincode: optionalText(12).regex(/^[\dA-Za-z\s-]*$/, "Invalid PIN code"),
    academicYearStart: z.number().int().min(1).max(12),
    receiptNote: optionalText(300),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Provide at least one field to update");

const role = z.enum(Object.values(ROLES), { error: "Choose a role" });

export const addMemberSchema = z.object({
  email,
  role,
  // Only used when the email has no EduFlow account yet
  name: z.string().trim().min(2, "Name must be at least 2 characters").max(100).optional(),
  password: strongPassword.optional(),
});

export const updateMemberSchema = z.object({ role });

const show = z.boolean();
const accent = z.enum(["indigo", "emerald", "teal", "maroon", "orange", "slate"]);

export const reportCardSettingsSchema = z
  .object({
    title: z.string().trim().min(2, "Title is too short").max(60),
    monthlyTitle: z.string().trim().min(2, "Title is too short").max(60),
    accent,
    signatures: z.array(z.string().trim().max(40)).max(3),
    note: optionalText(300),
    paper: z.enum(["a5", "a4"]),
    show: z
      .object({
        logo: show, schoolName: show, title: show, contact: show, admissionNo: show, rollNo: show, gradeColumn: show,
        resultColumn: show, percentage: show, rank: show, resultBox: show, remarks: show, attendance: show,
      })
      .partial(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
export const receiptSettingsSchema = z
  .object({
    title: z.string().trim().min(2, "Title is too short").max(60),
    accent: z.enum(["indigo", "emerald", "teal", "maroon", "orange", "slate"]),
    prefix: z.string().trim().min(1, "Enter a prefix").max(10).regex(/^[A-Za-z0-9/-]+$/, "Prefix: letters, digits, - and / only"),
    signatureLabel: z.string().trim().max(60),
    paper: z.enum(["a5", "a4"]),
    twoCopies: z.boolean(),
    receiptNote: optionalText(300),
    show: z
      .object({ logo: show, schoolName: show, title: show, contact: show, guardian: show, amountInWords: show, summary: show, concessions: show, receivedBy: show, signature: show, footer: show })
      .partial(),
  })
  .partial()
  .refine((v) => Object.keys(v).length > 0, "Nothing to change");
