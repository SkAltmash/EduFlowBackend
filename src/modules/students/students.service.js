import mongoose from "mongoose";
import Student from "../../models/Student.js";
import AppError from "../../utils/AppError.js";
import Counter from "../../models/Counter.js";
import Payment from "../../models/Payment.js";
import User from "../../models/User.js";
import { createStudentSchema, importFeesSchema } from "./students.validation.js";
import { createPayment } from "../fees/fees.service.js";
import { loadClassList } from "../academics/class-names.js";
import { assertStudentCapacity } from "../platform/subscription.js";

// Natural ordering for values like "Grade 2" < "Grade 10" and "A-9" < "A-10"
const COLLATION = { locale: "en", numericOrdering: true };

const SORTS = {
  newest: { createdAt: -1 },
  oldest: { createdAt: 1 },
  name: { firstName: 1, lastName: 1 },
  admissionNo: { admissionNo: 1 },
  grade: { grade: 1, section: 1, rollNo: 1 },
};

const SEARCH_FIELDS = ["firstName", "lastName", "admissionNo", "phone", "email", "guardianName", "guardianPhone"];

const ADMISSION_NO_TAKEN = (admissionNo) =>
  AppError.conflict(`Admission number "${admissionNo}" is already used by another student`, "ADMISSION_NO_TAKEN");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function serializeStudent(s) {
  return {
    id: String(s._id),
    admissionNo: s.admissionNo,
    firstName: s.firstName,
    lastName: s.lastName || "",
    fullName: [s.firstName, s.lastName].filter(Boolean).join(" "),
    gender: s.gender ?? null,
    dateOfBirth: s.dateOfBirth ?? null,
    grade: s.grade || "",
    section: s.section || "",
    rollNo: s.rollNo || "",
    email: s.email || "",
    phone: s.phone || "",
    guardianName: s.guardianName || "",
    guardianPhone: s.guardianPhone || "",
    guardianEmail: s.guardianEmail || "",
    address: s.address || "",
    admissionDate: s.admissionDate ?? null,
    status: s.status,
    notes: s.notes || "",
    classHistory: (s.classHistory ?? []).map((h) => ({ year: h.year, grade: h.grade, section: h.section || "", rollNo: h.rollNo || "", outcome: h.outcome })),
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  };
}

/** Splits validated input into $set / $unset so null clears a field instead of storing null. */
function toUpdate(data) {
  const $set = {};
  const $unset = {};
  for (const [key, value] of Object.entries(data)) {
    if (value === undefined) continue;
    if (value === null) $unset[key] = "";
    else $set[key] = value;
  }
  return { $set, $unset };
}

/** Drops null / undefined so a new document only stores real values. */
function compact(data) {
  return Object.fromEntries(Object.entries(data).filter(([, v]) => v !== null && v !== undefined));
}

function isDuplicateKey(err) {
  return err?.code === 11000;
}

/**
 * Puts the class and section into the school's spelling ("class v" → "5", "a" → "A"),
 * or throws when they aren't in the class list. `current` fills in whichever of the two
 * an update leaves out.
 */
function applyClass(classList, data, current = {}) {
  if (data.grade === undefined && data.section === undefined) return data;
  const grade = data.grade !== undefined ? data.grade ?? "" : current.grade ?? "";
  const section = data.section !== undefined ? data.section ?? "" : current.section ?? "";
  const r = classList.resolve(grade, section);
  if (r.error) throw AppError.badRequest(r.error.message, "INVALID_CLASS", [r.error]);
  return { ...data, grade: r.grade, section: r.section };
}

async function findStudentOrThrow(tenantId, id) {
  const student = await Student.findOne({ _id: id, tenantId });
  if (!student) throw AppError.notFound("Student not found");
  return student;
}

// ---------------------------------------------------------------------------
// Queries
// ---------------------------------------------------------------------------

export const MAX_EXPORT_ROWS = 10_000;

/** Mongo filter shared by the list and export endpoints. */
function buildListFilter(tenantId, { search, grade, section, status }) {
  const filter = { tenantId };
  if (status !== "all") filter.status = status;
  if (grade) filter.grade = grade;
  if (section) filter.section = section;

  if (search) {
    // Every word must match some field, so "ali khan" finds first "Ali" + last "Khan"
    filter.$and = search
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 5)
      .map((word) => {
        const re = new RegExp(escapeRegex(word), "i");
        return { $or: SEARCH_FIELDS.map((field) => ({ [field]: re })) };
      });
  }
  return filter;
}

export async function listStudents(tenantId, { page, limit, sort, ...filters }) {
  const filter = buildListFilter(tenantId, filters);
  const [students, total] = await Promise.all([
    Student.find(filter)
      .collation(COLLATION)
      .sort({ ...SORTS[sort], _id: 1 })
      .skip((page - 1) * limit)
      .limit(limit)
      .lean(),
    Student.countDocuments(filter),
  ]);

  return {
    students: students.map(serializeStudent),
    pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
  };
}

/** Every student matching the list filters (no paging), for CSV / Excel export. */
export async function exportStudents(tenantId, { sort, ...filters }) {
  const filter = buildListFilter(tenantId, filters);
  const [students, total] = await Promise.all([
    Student.find(filter).collation(COLLATION).sort({ ...SORTS[sort], _id: 1 }).limit(MAX_EXPORT_ROWS).lean(),
    Student.countDocuments(filter),
  ]);
  return { students: students.map(serializeStudent), total, truncated: total > students.length };
}

/** Distinct grades/sections (for filter dropdowns) and counts per status. */
export async function getStudentFilters(tenantId) {
  const tid = new mongoose.Types.ObjectId(String(tenantId));
  const [grades, sections, byStatus, classList] = await Promise.all([
    Student.distinct("grade", { tenantId: tid }),
    Student.distinct("section", { tenantId: tid }),
    Student.aggregate([{ $match: { tenantId: tid } }, { $group: { _id: "$status", count: { $sum: 1 } } }]),
    loadClassList(tenantId),
  ]);

  const sortNatural = (values) =>
    values.filter(Boolean).sort((a, b) => a.localeCompare(b, "en", { numeric: true }));
  const counts = Object.fromEntries(byStatus.map((s) => [s._id, s.count]));

  return {
    // In the school's class order (Nursery, LKG, 1, 2 …)
    grades: grades.filter(Boolean).sort(classList.compareGrades),
    sections: sortNatural(sections),
    counts: { total: byStatus.reduce((n, s) => n + s.count, 0), ...counts },
  };
}

export async function getStudent(tenantId, id) {
  return { student: serializeStudent(await findStudentOrThrow(tenantId, id)) };
}

// ---------------------------------------------------------------------------
// Mutations
// ---------------------------------------------------------------------------

/**
 * Adds a student. `feesPaid` records fees they've already paid: it's kept as advance and
 * pays off their dues as soon as a fee plan is assigned.
 */
export async function createStudent(tenantId, userId, { feesPaid, ...input }) {
  const data = applyClass(await loadClassList(tenantId), input);
  if ((data.status ?? "active") === "active") await assertStudentCapacity(tenantId, 1);
  let student;
  try {
    student = await Student.create({ ...compact(data), tenantId, createdBy: userId, updatedBy: userId });
  } catch (err) {
    if (isDuplicateKey(err)) throw ADMISSION_NO_TAKEN(data.admissionNo);
    throw err;
  }
  const payment = feesPaid ? (await createPayment(tenantId, { id: userId }, { ...feesPaid, studentId: String(student._id) })).payment : null;
  return { student: serializeStudent(student), ...(payment ? { payment } : {}) };
}

export async function updateStudent(tenantId, userId, id, input) {
  const existing = await findStudentOrThrow(tenantId, id);
  const data = applyClass(await loadClassList(tenantId), input, existing);
  const { $set, $unset } = toUpdate(data);

  try {
    const student = await Student.findOneAndUpdate(
      { _id: id, tenantId },
      { $set: { ...$set, updatedBy: userId }, ...(Object.keys($unset).length ? { $unset } : {}) },
      { returnDocument: "after", runValidators: true }
    );
    return { student: serializeStudent(student) };
  } catch (err) {
    if (isDuplicateKey(err)) throw ADMISSION_NO_TAKEN(data.admissionNo);
    throw err;
  }
}

export async function deleteStudent(tenantId, id) {
  const result = await Student.deleteOne({ _id: id, tenantId });
  if (result.deletedCount === 0) throw AppError.notFound("Student not found");
}

/**
 * Bulk import (rows already parsed from CSV by the client).
 * Each row is validated on its own; invalid rows are reported, valid rows are saved.
 * Row numbers in the response are 1-based data rows (header excluded).
 */
export async function importStudents(tenantId, userId, { students: rows, onDuplicate }) {
  const failed = [];
  const valid = [];
  const seen = new Set();
  const classList = await loadClassList(tenantId);

  rows.forEach((raw, index) => {
    const row = index + 1;
    const result = createStudentSchema.safeParse(raw);
    if (!result.success) {
      failed.push({
        row,
        admissionNo: typeof raw.admissionNo === "string" ? raw.admissionNo : "",
        errors: result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      });
      return;
    }
    // "Class V" in the file → "5" from the class list
    const cls = classList.resolve(result.data.grade, result.data.section);
    if (cls.error) {
      failed.push({ row, admissionNo: result.data.admissionNo, errors: [cls.error] });
      return;
    }
    result.data.grade = cls.grade;
    result.data.section = cls.section;
    const fees = importFeesSchema.safeParse(raw);
    if (!fees.success) {
      failed.push({ row, admissionNo: result.data.admissionNo, errors: fees.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) });
      return;
    }
    result.fees = fees.data;
    const key = result.data.admissionNo.toLowerCase();
    if (seen.has(key)) {
      failed.push({
        row,
        admissionNo: result.data.admissionNo,
        errors: [{ field: "admissionNo", message: "Duplicate admission number in this file" }],
      });
      return;
    }
    seen.add(key);
    valid.push({ row, data: result.data, fees: result.fees });
  });

  const existing = await Student.find(
    { tenantId, admissionNo: { $in: valid.map((v) => v.data.admissionNo) } },
    { admissionNo: 1 }
  ).lean();
  const existingNos = new Set(existing.map((s) => s.admissionNo));

  const toInsert = valid.filter((v) => !existingNos.has(v.data.admissionNo));
  // The plan's student limit counts the new active students in this file
  await assertStudentCapacity(tenantId, toInsert.filter((v) => (v.data.status ?? "active") === "active").length);
  const existingRows = valid.filter((v) => existingNos.has(v.data.admissionNo));

  let created = 0;
  let updated = 0;
  let skipped = 0;
  let insertedDocs = [];

  if (toInsert.length) {
    try {
      insertedDocs = await Student.insertMany(
        toInsert.map((v) => ({ ...compact(v.data), tenantId, createdBy: userId, updatedBy: userId })),
        { ordered: false }
      );
      created = insertedDocs.length;
    } catch (err) {
      // Another request inserted some of these admission numbers meanwhile
      if (!isDuplicateKey(err) && !err?.writeErrors) throw err;
      insertedDocs = err.insertedDocs ?? [];
      created = insertedDocs.length || (err.result?.insertedCount ?? 0);
      skipped += toInsert.length - created;
    }
  }

  // Fees already paid (only for students created now, so importing twice doesn't double them)
  const feesRecorded = await recordImportedFees(tenantId, userId, insertedDocs, toInsert);

  if (onDuplicate === "update" && existingRows.length) {
    const result = await Student.bulkWrite(
      existingRows.map(({ data }) => {
        const { $set, $unset } = toUpdate(data);
        return {
          updateOne: {
            filter: { tenantId, admissionNo: data.admissionNo },
            update: { $set: { ...$set, updatedBy: userId }, ...(Object.keys($unset).length ? { $unset } : {}) },
          },
        };
      }),
      { ordered: false }
    );
    updated = result.matchedCount;
  } else {
    skipped += existingRows.length;
  }

  return { total: rows.length, created, updated, skipped, failed, feesRecorded };
}

/** Saves "Fees paid" from an import as fees paid before EduFlow; they become each student's advance. */
async function recordImportedFees(tenantId, userId, insertedDocs, rows) {
  const feesByNo = new Map(rows.filter((v) => v.fees?.feesPaid > 0).map((v) => [v.data.admissionNo, v.fees]));
  const students = insertedDocs.filter((d) => feesByNo.has(d.admissionNo));
  if (!students.length) return { students: 0, amount: 0 };
  const receivedByName = (await User.findById(userId, { name: 1 }).lean())?.name ?? "";
  const today = new Date().toISOString().slice(0, 10);
  const first = await Counter.reserve(tenantId, "opening", students.length);
  const docs = students.map((st, i) => {
    const f = feesByNo.get(st.admissionNo);
    return {
      tenantId,
      receiptNo: `OB${String(first + i).padStart(5, "0")}`,
      kind: "opening",
      studentId: st._id,
      student: {
        fullName: [st.firstName, st.lastName].filter(Boolean).join(" "),
        admissionNo: st.admissionNo,
        grade: st.grade || "",
        section: st.section || "",
        guardianName: st.guardianName || "",
      },
      date: f.feesPaidDate || today,
      amount: f.feesPaid,
      mode: f.feesPaidMode || "cash",
      note: f.feesNote || "Paid before EduFlow (imported)",
      allocations: [],
      receivedBy: userId,
      receivedByName,
    };
  });
  await Payment.insertMany(docs);
  return { students: docs.length, amount: docs.reduce((t, d) => t + d.amount, 0) };
}
