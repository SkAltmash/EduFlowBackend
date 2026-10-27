import { z } from "zod";
import { objectId } from "../auth/auth.validation.js";

export const idParamSchema = objectId;

export const replaceSchema = z.object({
  assignments: z
    .array(
      z.object({
        grade: z.string().trim().min(1, "Choose a class").max(50),
        section: z.string().trim().max(20).default(""),
        // "" = class teacher
        subject: z.string().trim().max(60).default(""),
      })
    )
    .max(100),
});
