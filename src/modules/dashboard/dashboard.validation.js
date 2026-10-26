import { z } from "zod";
import { day } from "../attendance/attendance.validation.js";

// The browser sends its own "today" so the dashboard follows the school's calendar, not the server's
export const dashboardQuery = z.object({ date: day });
