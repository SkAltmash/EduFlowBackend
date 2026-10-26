// Matching what people type ("Class 5", "V", "5th", "std 5") to the school's class list.
import SchoolClass from "../../models/SchoolClass.js";

const ROMAN = { i: 1, ii: 2, iii: 3, iv: 4, v: 5, vi: 6, vii: 7, viii: 8, ix: 9, x: 10, xi: 11, xii: 12 };

/** A comparison key: "Class V" → "5", "5th" → "5", "Std. 10 " → "10", "LKG" → "lkg". */
export function classKey(value) {
  let s = String(value ?? "")
    .toLowerCase()
    .replace(/[._]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  s = s.replace(/^(class|grade|std|standard|cls)\s*-?\s*/, "");
  // A roman numeral word becomes a number ("xi science" → "11 science")
  s = s.replace(/^([ivx]+)\b/, (m) => (ROMAN[m] ? String(ROMAN[m]) : m));
  s = s.replace(/^(\d+)(st|nd|rd|th)\b/, "$1");
  // "12-Science", "12 - Science" and "12 Science" are the same class
  return s.replace(/\s*-\s*/g, " ").trim();
}

/** Natural order fallback for values that aren't in the class list. */
export const naturalCompare = (a, b) => String(a ?? "").localeCompare(String(b ?? ""), "en", { numeric: true });

/**
 * The school's class list with helpers. `resolve` returns the canonical
 * { grade, section } or an error message; with no class list every value is accepted
 * (schools that haven't set up classes keep working as before).
 */
export async function loadClassList(tenantId) {
  const classes = await SchoolClass.find({ tenantId }).sort({ order: 1 }).lean();
  const byKey = new Map(classes.map((c) => [classKey(c.name), c]));
  const orderOf = new Map(classes.map((c) => [c.name, c.order]));

  function resolve(grade, section) {
    const g = String(grade ?? "").trim();
    const sec = String(section ?? "").trim();
    if (!classes.length) return { grade: g, section: sec };
    if (!g) {
      return sec ? { error: { field: "grade", message: "Choose a class for this section" } } : { grade: "", section: "" };
    }
    const cls = byKey.get(classKey(g));
    if (!cls) return { error: { field: "grade", message: `Class "${g}" isn't in your class list (Settings → Classes)` } };
    if (!sec) return { grade: cls.name, section: "" };
    const match = cls.sections.find((s) => s.toLowerCase() === sec.toLowerCase());
    if (!match) {
      return {
        error: {
          field: "section",
          message: cls.sections.length ? `Class ${cls.name} has sections ${cls.sections.join(", ")}, not "${sec}"` : `Class ${cls.name} has no sections`,
        },
      };
    }
    return { grade: cls.name, section: match };
  }

  /** Sorts by the school's class order, then naturally for anything not in the list. */
  function compareGrades(a, b) {
    const oa = orderOf.get(a);
    const ob = orderOf.get(b);
    if (oa !== undefined && ob !== undefined) return oa - ob;
    if (oa !== undefined) return -1;
    if (ob !== undefined) return 1;
    return naturalCompare(a, b);
  }

  return { classes, resolve, compareGrades, has: classes.length > 0 };
}
