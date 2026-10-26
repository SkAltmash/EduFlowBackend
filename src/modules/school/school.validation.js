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
