import mongoose from "mongoose";
import AcademicYear from "../../models/AcademicYear.js";
import Attendance from "../../models/Attendance.js";
import Exam from "../../models/Exam.js";
import FeePlan from "../../models/FeePlan.js";
import Invoice from "../../models/Invoice.js";
import Promotion from "../../models/Promotion.js";
import SchoolClass from "../../models/SchoolClass.js";
import SchoolSettings from "../../models/SchoolSettings.js";
import Student from "../../models/Student.js";
import TeachingAssignment from "../../models/TeachingAssignment.js";
import User from "../../models/User.js";
import AppError from "../../utils/AppError.js";
import { classKey, naturalCompare } from "./class-names.js";

const DAY_MS = 86_400_000;
const oid = (id) => new mongoose.Types.ObjectId(String(id));
const fullName = (s) => [s.firstName, s.lastName].filter(Boolean).join(" ");
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const utcToday = () => new Date().toISOString().slice(0, 10);

/** Records that store a class name; FeePlan has a class but no section. */
const CLASS_COLLECTIONS = [Student, Attendance, Exam, Invoice, TeachingAssignment];

function serializeClass(c, counts) {
  return {
    id: String(c._id),
    name: c.name,
    order: c.order,
    sections: c.sections,
    subjects: c.subjects.map((s) => ({ id: String(s._id), name: s.name, maxMarks: s.maxMarks ?? null })),
    students: counts?.total ?? 0,
    sectionCounts: counts?.sections ?? {},
  };
}

function serializeYear(y) {
  return { id: String(y._id), name: y.name, startDate: y.startDate, endDate: y.endDate, isCurrent: y.isCurrent };
}

/**
 * Changes a class (and optionally section) name on every record that stores it.
 * `from.section` undefined = every section of the class (only the class name changes).
 */
async function renameEverywhere(tenantId, from, to, session) {
  const filter = { tenantId, grade: from.grade, ...(from.section !== undefined ? { section: from.section } : {}) };
  const set = { grade: to.grade, ...(to.section !== undefined ? { section: to.section } : {}) };
  // One at a time: a transaction can't run operations in parallel
  const results = [];
  for (const M of CLASS_COLLECTIONS) results.push(await M.updateMany(filter, { $set: set }, { session }));
  if (from.section === undefined) await FeePlan.updateMany({ tenantId, grade: from.grade }, { $set: { grade: to.grade } }, { session });
  return { students: results[0].modifiedCount };
}

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

/** Active students per class and section, plus class names on students that aren't in the list. */
export async function listClasses(tenantId) {
  const [classes, groups] = await Promise.all([
    SchoolClass.find({ tenantId }).sort({ order: 1 }).lean(),
    Student.aggregate([
      { $match: { tenantId: oid(tenantId), status: "active" } },
      { $group: { _id: { grade: "$grade", section: "$section" }, count: { $sum: 1 } } },
    ]),
  ]);

  const counts = new Map();
  for (const g of groups) {
    const grade = g._id.grade || "";
    const entry = counts.get(grade) ?? { total: 0, sections: {} };
    entry.total += g.count;
    entry.sections[g._id.section || ""] = (entry.sections[g._id.section || ""] ?? 0) + g.count;
    counts.set(grade, entry);
  }

  const names = new Set(classes.map((c) => c.name));
  const unknown = [...counts.entries()]
    .filter(([grade]) => grade && !names.has(grade))
    .map(([grade, c]) => ({
      grade,
      students: c.total,
      sections: Object.keys(c.sections).filter(Boolean).sort(naturalCompare),
      // The class it most likely means ("Class 5" → "5")
      suggestion: classes.find((cl) => classKey(cl.name) === classKey(grade))?.name ?? null,
    }))
    .sort((a, b) => naturalCompare(a.grade, b.grade));

  // Sections used by students but missing from their class
  const strays = classes.flatMap((c) =>
    Object.entries(counts.get(c.name)?.sections ?? {})
      .filter(([sec]) => sec && !c.sections.includes(sec))
      .map(([section, students]) => ({ grade: c.name, section, students }))
  );

  return {
    classes: classes.map((c) => serializeClass(c, counts.get(c.name))),
    unknown,
    strays,
    unassigned: counts.get("")?.total ?? 0,
  };
}

async function assertNameFree(tenantId, name, exceptId) {
  const key = classKey(name);
  const clash = (await SchoolClass.find({ tenantId }, { name: 1 }).lean()).find((c) => String(c._id) !== String(exceptId) && classKey(c.name) === key);
  if (clash) throw AppError.conflict(`"${name}" is the same class as "${clash.name}"`, "CLASS_EXISTS");
}

export async function createClass(tenantId, { name, sections, subjects }) {
  await assertNameFree(tenantId, name);
  const last = await SchoolClass.findOne({ tenantId }).sort({ order: -1 }).lean();
  await SchoolClass.create({ tenantId, name, sections, subjects, order: (last?.order ?? 0) + 1 });
  return listClasses(tenantId);
}

/** Several classes at once (e.g. "Nursery to 10"), skipping any that already exist. */
export async function bulkCreateClasses(tenantId, { names, sections }) {
  const existing = await SchoolClass.find({ tenantId }, { name: 1, order: 1 }).lean();
  const keys = new Set(existing.map((c) => classKey(c.name)));
  let order = Math.max(0, ...existing.map((c) => c.order));
  const docs = [];
  for (const name of names) {
    if (keys.has(classKey(name))) continue;
    keys.add(classKey(name));
    docs.push({ tenantId, name, sections, subjects: [], order: ++order });
  }
  if (docs.length) await SchoolClass.insertMany(docs);
  return { ...(await listClasses(tenantId)), created: docs.length };
}

export async function updateClass(tenantId, id, changes) {
  const cls = await SchoolClass.findOne({ _id: id, tenantId });
  if (!cls) throw AppError.notFound("Class not found");

  if (changes.sections) {
    const removed = cls.sections.filter((s) => !changes.sections.includes(s));
    if (removed.length) {
      const inUse = await Student.countDocuments({ tenantId, status: "active", grade: cls.name, section: { $in: removed } });
      if (inUse) {
        throw AppError.conflict(
          `${inUse} active student${inUse === 1 ? " is" : "s are"} in section ${removed.join(", ")}. Move them first (use Merge to move a whole section).`,
          "SECTION_IN_USE"
        );
      }
    }
  }

  const renaming = changes.name !== undefined && changes.name !== cls.name;
  if (renaming) await assertNameFree(tenantId, changes.name, id);

  await mongoose.connection.transaction(async (session) => {
    if (renaming) await renameEverywhere(tenantId, { grade: cls.name }, { grade: changes.name }, session);
    Object.assign(cls, changes);
    await cls.save({ session });
  });
  return listClasses(tenantId);
}

export async function reorderClasses(tenantId, { ids }) {
  const classes = await SchoolClass.find({ tenantId }, { _id: 1 }).lean();
  const all = new Set(classes.map((c) => String(c._id)));
  if (ids.length !== all.size || !ids.every((id) => all.has(id))) {
    throw AppError.badRequest("Send every class exactly once", "INVALID_ORDER");
  }
  await SchoolClass.bulkWrite(ids.map((id, i) => ({ updateOne: { filter: { _id: id, tenantId }, update: { $set: { order: i + 1 } } } })));
  return listClasses(tenantId);
}

export async function deleteClass(tenantId, id) {
  const cls = await SchoolClass.findOne({ _id: id, tenantId }).lean();
  if (!cls) throw AppError.notFound("Class not found");
  const inUse = await Student.countDocuments({ tenantId, status: "active", grade: cls.name });
  if (inUse) throw AppError.conflict(`${inUse} active student${inUse === 1 ? " is" : "s are"} in this class. Move them first.`, "CLASS_IN_USE");
  await SchoolClass.deleteOne({ _id: id, tenantId });
  return listClasses(tenantId);
}

/** Where a name sits in a typical Indian school, for ordering classes created from student data. */
function typicalRank(name) {
  const k = classKey(name);
  const early = ["playgroup", "play group", "pre nursery", "nursery", "pre kg", "prekg", "pre primary", "lkg", "kg", "kg1", "kg 1", "ukg", "kg2", "kg 2"];
  const i = early.indexOf(k);
  if (i >= 0) return i - 100;
  const n = parseInt(k, 10);
  return Number.isNaN(n) ? 1000 : n;
}

/**
 * Builds the class list from what students already have, folding spellings of the same
 * class together ("Class 5", "V", "5" → the most used one) and renaming them everywhere.
 */
export async function setupFromStudents(tenantId) {
  const [existing, groups] = await Promise.all([
    SchoolClass.find({ tenantId }).lean(),
    Student.aggregate([
      { $match: { tenantId: oid(tenantId), grade: { $nin: ["", null] } } },
      { $group: { _id: { grade: "$grade", section: "$section" }, count: { $sum: 1 } } },
    ]),
  ]);

  // key → { spellings: Map(name → count), sections: Map(lower → { name, count }) }
  const byKey = new Map();
  for (const g of groups) {
    const key = classKey(g._id.grade);
    const entry = byKey.get(key) ?? { spellings: new Map(), sections: new Map() };
    entry.spellings.set(g._id.grade, (entry.spellings.get(g._id.grade) ?? 0) + g.count);
    const sec = (g._id.section || "").trim();
    if (sec) {
      const s = entry.sections.get(sec.toLowerCase()) ?? { name: sec, count: 0, spellings: new Set() };
      s.count += g.count;
      s.spellings.add(sec);
      // Prefer the upper-case spelling of single letters ("a" → "A")
      if (sec === sec.toUpperCase()) s.name = sec;
      entry.sections.set(sec.toLowerCase(), s);
    }
    byKey.set(key, entry);
  }

  const existingByKey = new Map(existing.map((c) => [classKey(c.name), c]));
  let order = Math.max(0, ...existing.map((c) => c.order));
  const created = [];
  const renamed = [];

  await mongoose.connection.transaction(async (session) => {
    const fresh = [...byKey.entries()]
      .filter(([key]) => !existingByKey.has(key))
      .sort(([, a], [, b]) => {
        const na = [...a.spellings.keys()][0];
        const nb = [...b.spellings.keys()][0];
        return typicalRank(na) - typicalRank(nb) || naturalCompare(na, nb);
      });

    for (const [key, entry] of byKey) {
      const target = existingByKey.get(key);
      const name = target?.name ?? [...entry.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
      const sectionNames = [...entry.sections.values()].map((s) => s.name);

      if (target) {
        const add = sectionNames.filter((s) => !target.sections.some((t) => t.toLowerCase() === s.toLowerCase()));
        if (add.length) await SchoolClass.updateOne({ _id: target._id }, { $push: { sections: { $each: add } } }, { session });
      }

      // Fold other spellings (and section case variants) into the chosen name
      for (const [spelling, count] of entry.spellings) {
        if (spelling !== name) {
          await renameEverywhere(tenantId, { grade: spelling }, { grade: name }, session);
          renamed.push({ from: spelling, to: name, students: count });
        }
      }
      for (const s of entry.sections.values()) {
        for (const spelling of s.spellings) {
          if (spelling !== s.name) await renameEverywhere(tenantId, { grade: name, section: spelling }, { grade: name, section: s.name }, session);
        }
      }
    }

    for (const [, entry] of fresh) {
      const name = [...entry.spellings.entries()].sort((a, b) => b[1] - a[1] || a[0].length - b[0].length)[0][0];
      const sectionNames = [...entry.sections.values()].map((s) => s.name).sort(naturalCompare);
      await SchoolClass.create([{ tenantId, name, sections: sectionNames, subjects: [], order: ++order }], { session });
      created.push(name);
    }
  });

  return { ...(await listClasses(tenantId)), created, renamed };
}

/** Moves every record of a class (or one section of it) into a class of the list. */
export async function mergeClass(tenantId, { from, to }) {
  const target = await SchoolClass.findOne({ _id: to.classId, tenantId }).lean();
  if (!target) throw AppError.notFound("Class not found");
  const section = to.section ? target.sections.find((s) => s.toLowerCase() === to.section.toLowerCase()) : "";
  if (to.section && !section) throw AppError.badRequest(`Class ${target.name} has no section "${to.section}"`, "INVALID_SECTION");
  if (from.grade === target.name && (from.section === undefined || from.section === section)) {
    throw AppError.badRequest("That's the same class and section", "SAME_CLASS");
  }

  let moved = 0;
  await mongoose.connection.transaction(async (session) => {
    // A whole class into a class without sections chosen keeps each record's section only when it exists there
    const result = await renameEverywhere(
      tenantId,
      { grade: from.grade, ...(from.section !== undefined ? { section: from.section } : {}) },
      { grade: target.name, ...(from.section !== undefined || to.section ? { section } : {}) },
      session
    );
    moved = result.students;
  });
  return { ...(await listClasses(tenantId)), moved };
}

// ---------------------------------------------------------------------------
// Academic years
// ---------------------------------------------------------------------------

/** The year containing `today`, given the month the school year starts (4 = April). */
export function yearFor(today, startMonth) {
  const [y, m] = today.split("-").map(Number);
  const start = m >= startMonth ? y : y - 1;
  const startDate = `${start}-${String(startMonth).padStart(2, "0")}-01`;
  const next = `${start + 1}-${String(startMonth).padStart(2, "0")}-01`;
  const name = startMonth === 1 ? String(start) : `${start}-${String((start + 1) % 100).padStart(2, "0")}`;
  return { name, startDate, endDate: addDays(next, -1) };
}

/** Years, newest first. A school's first call creates the current year from its profile. */
export async function listYears(tenantId) {
  let years = await AcademicYear.find({ tenantId }).sort({ startDate: -1 }).lean();
  if (!years.length) {
    const settings = await SchoolSettings.findOne({ tenantId }, { "profile.academicYearStart": 1 }).lean();
    const y = yearFor(utcToday(), settings?.profile?.academicYearStart ?? 4);
    try {
      await AcademicYear.create({ tenantId, ...y, isCurrent: true });
    } catch (err) {
      // Two first calls at once: the other one created it
      if (err?.code !== 11000) throw err;
    }
    years = await AcademicYear.find({ tenantId }).sort({ startDate: -1 }).lean();
  }
  return { years: years.map(serializeYear), current: serializeYear(years.find((y) => y.isCurrent) ?? years[0]) };
}

export async function createYear(tenantId, data) {
  if (await AcademicYear.exists({ tenantId, name: data.name })) throw AppError.conflict(`Year ${data.name} already exists`, "YEAR_EXISTS");
  await listYears(tenantId);
  await AcademicYear.create({ tenantId, ...data, isCurrent: false });
  return listYears(tenantId);
}

export async function updateYear(tenantId, id, { isCurrent, ...changes }) {
  const year = await AcademicYear.findOne({ _id: id, tenantId });
  if (!year) throw AppError.notFound("Year not found");
  const start = changes.startDate ?? year.startDate;
  const end = changes.endDate ?? year.endDate;
  if (start >= end) throw AppError.badRequest("The year must end after it starts", "INVALID_DATES", [{ field: "endDate", message: "The year must end after it starts" }]);
  if (changes.name && changes.name !== year.name && (await AcademicYear.exists({ tenantId, name: changes.name }))) {
    throw AppError.conflict(`Year ${changes.name} already exists`, "YEAR_EXISTS");
  }

  const oldName = year.name;
  await mongoose.connection.transaction(async (session) => {
    if (isCurrent) await AcademicYear.updateMany({ tenantId, _id: { $ne: year._id } }, { $set: { isCurrent: false } }, { session });
    Object.assign(year, changes, isCurrent ? { isCurrent: true } : {});
    await year.save({ session });
    // Keep history readable after a rename
    if (changes.name && changes.name !== oldName) {
      await Student.updateMany(
        { tenantId, "classHistory.year": oldName },
        { $set: { "classHistory.$[h].year": changes.name } },
        { arrayFilters: [{ "h.year": oldName }], session }
      );
      await Promotion.updateMany({ tenantId, fromYear: oldName }, { $set: { fromYear: changes.name } }, { session });
      await Promotion.updateMany({ tenantId, toYear: oldName }, { $set: { toYear: changes.name } }, { session });
      await FeePlan.updateMany({ tenantId, academicYear: oldName }, { $set: { academicYear: changes.name } }, { session });
    }
  });
  return listYears(tenantId);
}

export async function deleteYear(tenantId, id) {
  const year = await AcademicYear.findOne({ _id: id, tenantId }).lean();
  if (!year) throw AppError.notFound("Year not found");
  if (year.isCurrent) throw AppError.badRequest("The current year can't be deleted. Make another year current first.", "YEAR_IS_CURRENT");
  const used = await Promise.all([
    Student.exists({ tenantId, "classHistory.year": year.name }),
    Promotion.exists({ tenantId, $or: [{ fromYear: year.name }, { toYear: year.name }], "undone.at": { $exists: false } }),
  ]);
  if (used.some(Boolean)) throw AppError.conflict("Student class history uses this year, so it can't be deleted", "YEAR_IN_USE");
  await AcademicYear.deleteOne({ _id: id, tenantId });
  return listYears(tenantId);
}

// ---------------------------------------------------------------------------
// Year-end promotion
// ---------------------------------------------------------------------------

/** Everything the promotion wizard needs: classes in order with their active students. */
export async function promotionPreview(tenantId) {
  const [{ classes, unknown, unassigned }, { current }, students] = await Promise.all([
    listClasses(tenantId),
    listYears(tenantId),
    Student.find({ tenantId, status: "active", grade: { $nin: ["", null] } }, { firstName: 1, lastName: 1, admissionNo: 1, grade: 1, section: 1, rollNo: 1 }).lean(),
  ]);
  const byGrade = new Map();
  for (const s of students) {
    const rows = byGrade.get(s.grade) ?? [];
    rows.push({ id: String(s._id), fullName: fullName(s), admissionNo: s.admissionNo, section: s.section || "", rollNo: s.rollNo || "" });
    byGrade.set(s.grade, rows);
  }
  const cmp = (a, b) => naturalCompare(a.section, b.section) || naturalCompare(a.rollNo || "~", b.rollNo || "~") || a.fullName.localeCompare(b.fullName);

  return {
    currentYear: current,
    // The year after the current one, starting the day after it ends
    nextYear: { ...yearFor(addDays(current.endDate, 1), Number(addDays(current.endDate, 1).slice(5, 7))), startDate: addDays(current.endDate, 1) },
    classes: classes.map((c, i) => ({
      ...c,
      // The next class up; the last class graduates
      suggestedTarget: classes[i + 1]?.id ?? "graduate",
      roster: (byGrade.get(c.name) ?? []).sort(cmp),
    })),
    unknown,
    unassigned,
  };
}

const OUTCOME = { retain: "retained", leave: "left", graduate: "graduated" };

/**
 * Moves every active student of each chosen class up (or graduates them) and starts the
 * new year. Each student's year is written to their class history; undo restores it all.
 */
export async function promote(actor, { toYear, moves, exceptions, clearRollNumbers }) {
  const tenantId = actor.tenantId;
  const [classes, { current }] = await Promise.all([SchoolClass.find({ tenantId }).lean(), listYears(tenantId)]);
  const byId = new Map(classes.map((c) => [String(c._id), c]));
  if (toYear.name === current.name) throw AppError.badRequest(`Students are already in ${current.name}. Choose the new year.`, "SAME_YEAR");

  for (const m of moves) {
    if (!byId.has(m.classId)) throw AppError.badRequest("A class in this promotion doesn't exist any more. Reload and try again.", "INVALID_CLASS");
    if (!["graduate", "stay"].includes(m.target) && !byId.has(m.target)) throw AppError.badRequest("A target class doesn't exist any more. Reload and try again.", "INVALID_CLASS");
  }
  if (new Set(moves.map((m) => m.classId)).size !== moves.length) throw AppError.badRequest("Each class can appear only once", "DUPLICATE_CLASS");

  const moveByName = new Map(moves.map((m) => [byId.get(m.classId).name, m]));
  const students = await Student.find({ tenantId, status: "active", grade: { $in: [...moveByName.keys()] } }, { grade: 1, section: 1, rollNo: 1, status: 1 }).lean();
  const exceptionBy = new Map(exceptions.map((e) => [e.studentId, e.action]));

  const counts = { promoted: 0, retained: 0, graduated: 0, left: 0 };
  let noSection = 0;
  const entries = students.map((s) => {
    const before = { grade: s.grade, section: s.section || "", rollNo: s.rollNo || "", status: s.status };
    const move = moveByName.get(s.grade);
    const action = exceptionBy.get(String(s._id)) ?? (move.target === "graduate" ? "graduate" : move.target === "stay" ? "retain" : "promote");
    let after;
    if (action === "promote") {
      const target = byId.get(move.target);
      // Same section if the next class has it; the only section if it has one; otherwise none yet
      const section = target.sections.find((x) => x.toLowerCase() === before.section.toLowerCase()) ?? (target.sections.length === 1 ? target.sections[0] : "");
      if (!section && target.sections.length) noSection += 1;
      after = { grade: target.name, section, rollNo: clearRollNumbers ? "" : before.rollNo, status: "active" };
    } else if (action === "retain") {
      after = { ...before, rollNo: clearRollNumbers ? "" : before.rollNo };
    } else {
      after = { ...before, status: action === "leave" ? "left" : "graduated" };
    }
    const outcome = action === "promote" ? "promoted" : OUTCOME[action];
    counts[outcome] += 1;
    return { studentId: s._id, outcome, before, after };
  });
  if (!entries.length) throw AppError.badRequest("No active students in the chosen classes", "NOTHING_TO_PROMOTE");

  const user = await User.findById(actor.id, { name: 1 }).lean();
  let promotion;
  await mongoose.connection.transaction(async (session) => {
    [promotion] = await Promotion.create([{ tenantId, fromYear: current.name, toYear: toYear.name, entries, counts, createdBy: actor.id, createdByName: user?.name ?? "" }], { session });
    await Student.bulkWrite(
      entries.map((e) => ({
        updateOne: {
          filter: { _id: e.studentId, tenantId },
          update: {
            $set: { ...e.after, updatedBy: actor.id },
            $push: { classHistory: { year: current.name, ...e.before, outcome: e.outcome, promotionId: promotion._id } },
          },
        },
      })),
      { session }
    );
    // Start the new year
    await AcademicYear.updateMany({ tenantId }, { $set: { isCurrent: false } }, { session });
    await AcademicYear.updateOne(
      { tenantId, name: toYear.name },
      { $set: { isCurrent: true }, $setOnInsert: { startDate: toYear.startDate, endDate: toYear.endDate } },
      { upsert: true, session }
    );
  });

  return { promotion: serializePromotion(promotion.toObject()), noSection };
}

function serializePromotion(p) {
  return {
    id: String(p._id),
    fromYear: p.fromYear,
    toYear: p.toYear,
    counts: p.counts,
    students: p.entries?.length ?? 0,
    createdAt: p.createdAt,
    createdByName: p.createdByName ?? "",
    undone: p.undone?.at ? { at: p.undone.at, byName: p.undone.byName ?? "", restored: p.undone.restored ?? 0, skipped: p.undone.skipped ?? 0 } : null,
  };
}

export async function listPromotions(tenantId) {
  const list = await Promotion.find({ tenantId }, { entries: 0 }).sort({ createdAt: -1 }).limit(20).lean();
  const latestActive = list.find((p) => !p.undone?.at);
  return { promotions: list.map((p) => ({ ...serializePromotion(p), canUndo: String(p._id) === String(latestActive?._id) })) };
}

/**
 * Puts students back as they were before the latest promotion. A student changed by hand
 * since then (different class, section, roll no or status) is left alone and counted as skipped.
 */
export async function undoPromotion(actor, id) {
  const tenantId = actor.tenantId;
  const promotion = await Promotion.findOne({ _id: id, tenantId });
  if (!promotion) throw AppError.notFound("Promotion not found");
  const latest = await Promotion.findOne({ tenantId, "undone.at": { $exists: false } }).sort({ createdAt: -1 }).lean();
  if (promotion.undone?.at || String(latest?._id) !== String(promotion._id)) {
    throw AppError.badRequest("Only the most recent promotion can be undone", "CANNOT_UNDO");
  }

  const user = await User.findById(actor.id, { name: 1 }).lean();
  let restored = 0;
  await mongoose.connection.transaction(async (session) => {
    const result = await Student.bulkWrite(
      promotion.entries.map((e) => ({
        updateOne: {
          filter: { _id: e.studentId, tenantId, grade: e.after.grade, section: e.after.section, rollNo: e.after.rollNo, status: e.after.status },
          update: { $set: { ...e.before.toObject(), updatedBy: actor.id }, $pull: { classHistory: { promotionId: promotion._id } } },
        },
      })),
      { session }
    );
    restored = result.modifiedCount;
    promotion.undone = { at: new Date(), by: actor.id, byName: user?.name ?? "", restored, skipped: promotion.entries.length - restored };
    await promotion.save({ session });
    await AcademicYear.updateMany({ tenantId }, { $set: { isCurrent: false } }, { session });
    await AcademicYear.updateOne({ tenantId, name: promotion.fromYear }, { $set: { isCurrent: true } }, { session });
  });

  return { promotion: serializePromotion(promotion.toObject()) };
}
