import { z } from "zod";

export const objectId = z.string().regex(/^[a-f\d]{24}$/i, "Invalid id");

export const email = z
  .string({ error: "Email is required" })
  .trim()
  .toLowerCase()
  .max(254, "Email is too long")
  .pipe(z.email("Invalid email address"));

export const strongPassword = z
  .string({ error: "Password is required" })
  .min(8, "Password must be at least 8 characters")
  // bcrypt only uses the first 72 bytes
  .refine((value) => Buffer.byteLength(value, "utf8") <= 72, "Password must be at most 72 bytes")
  .regex(/[a-z]/, "Password must contain a lowercase letter")
  .regex(/[A-Z]/, "Password must contain an uppercase letter")
  .regex(/\d/, "Password must contain a number")
  .regex(/[^A-Za-z0-9]/, "Password must contain a special character");

export const registerSchema = z.object({
  name: z
    .string({ error: "Name is required" })
    .trim()
    .min(2, "Name must be at least 2 characters")
    .max(100, "Name must be at most 100 characters"),
  email,
  password: strongPassword,
  // The organization (school, tuition center, ...) being created
  tenantName: z
    .string()
    .trim()
    .min(2, "Organization name must be at least 2 characters")
    .max(150, "Organization name must be at most 150 characters")
    .optional(),
  // From POST /api/auth/otp/verify (purpose "register"); required when the platform asks for it
  phoneToken: z.string().max(2000).optional(),
});

// Login does not enforce the strength rules, so policy changes never lock users out
export const loginSchema = z.object({
  email,
  password: z.string({ error: "Password is required" }).min(1, "Password is required").max(200),
});

export const selectTenantSchema = z.object({
  tenantId: objectId,
});

export const updateMeSchema = z.object({
  name: z.string({ error: "Name is required" }).trim().min(2, "Name must be at least 2 characters").max(100, "Name must be at most 100 characters"),
});

export const changePasswordSchema = z
  .object({
    currentPassword: z.string({ error: "Current password is required" }).min(1, "Current password is required").max(200),
    newPassword: strongPassword,
  })
  .refine((v) => v.currentPassword !== v.newPassword, { message: "Choose a password different from the current one", path: ["newPassword"] });

const phone = z.string({ error: "Enter your mobile number" }).trim().min(10, "Enter a valid 10-digit mobile number").max(20);
const otpCode = z.string().trim().regex(/^\d{4,8}$/, "Enter the code from the SMS");

export const otpSendSchema = z.object({ phone, purpose: z.enum(["login", "register"]) });
export const otpVerifySchema = z.object({ challengeId: z.string().trim().min(1).max(40), code: otpCode, purpose: z.enum(["login", "register"]) });
export const phoneChangeSchema = z.object({ phone });
export const phoneChangeVerifySchema = z.object({ challengeId: z.string().trim().min(1).max(40), code: otpCode });

export const twoFactorSchema = z.object({
  token: z.string().min(10).max(2000),
  code: z.string().trim().regex(/^\d{6}$/, "Enter the 6-digit code"),
});
