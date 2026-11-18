// "How do I…" guides for the assistant's how_to tool: short, exact steps that match the app's
// screens, so answers name the real pages and buttons. Each guide lists the roles that can
// do it; the tool only returns what the member's role can actually do.
import { ROLES } from "../../models/Membership.js";

const ALL = Object.values(ROLES);
const MANAGERS = [ROLES.OWNER, ROLES.ADMIN];
const FEES = [ROLES.OWNER, ROLES.ADMIN, ROLES.ACCOUNTANT];
const TEACHING = [ROLES.OWNER, ROLES.ADMIN, ROLES.TEACHER];

export const GUIDES = [
  { id: "add_student", title: "Add a student", roles: MANAGERS, words: "add new student admission enrol enroll", steps: ["Open Students.", "Click Add student.", "Fill in name, admission number, class and section, and the guardian's phone.", "Save. If they've already paid some fees, add it in the same form as fees paid before Zaref Campus."], link: "/app/students" },
  { id: "import_students", title: "Import students from Excel", roles: MANAGERS, words: "import excel csv upload many students bulk sheet", steps: ["Open Students.", "Click Import.", "Download the template, fill one student per row and save it.", "Upload the file, check the preview and import."], link: "/app/students" },
  { id: "mark_attendance", title: "Mark attendance", roles: TEACHING, words: "attendance mark present absent register hajiri", steps: ["Open Attendance.", "Pick the date and the class.", "Tap each student as Present, Absent, Late or Leave.", "Click Save attendance. It works offline too and saves when you're back online."], link: "/app/attendance" },
  { id: "fee_plan", title: "Create and assign a fee plan", roles: FEES, words: "fee plan structure assign installments due dates tuition", steps: ["Open Fees and go to the Fee plans tab.", "Click New fee plan: name it, choose the class and add the instalments with amounts and due dates.", "Click Assign to students, choose the class (or particular students) and assign.", "Students who join later: open Assign again; only those without the plan are added."], link: "/app/fees?tab=plans" },
  { id: "collect_fee", title: "Collect a fee and print the receipt", roles: FEES, words: "collect fee payment receive receipt print paid cash upi", steps: ["Open Fees and click Collect fee (or open the student's fee account).", "Choose the student, enter the amount, payment mode and date.", "Save: the receipt opens to print, download or send on WhatsApp.", "Anything more than what's due is kept as advance and used for future dues."], link: "/app/fees" },
  { id: "concession", title: "Give a fee concession", roles: FEES, words: "concession discount scholarship waive reduce fee", steps: ["Open Fees and go to the Concessions tab (or open the student's fee account).", "Choose the student and set the concession: a percentage, a fixed amount off, or free.", "Save. Their dues are updated straight away."], link: "/app/fees?tab=concessions" },
  { id: "fee_reminders", title: "Send fee reminders", roles: FEES, words: "reminder remind overdue pending parents whatsapp dues", steps: ["Open Fees and go to the Students tab.", "Choose Overdue (or Has balance) and a class if you like.", "Click Send reminders: messages go one by one on WhatsApp, or automatically with the WhatsApp API.", "For a personal message per student, use Personal messages (AI) beside it."], link: "/app/fees?tab=students" },
  { id: "new_test", title: "Create a test and enter marks", roles: TEACHING, words: "test exam marks enter create result unit term", steps: ["Open Tests and click New test.", "Choose the class, add the subjects with maximum marks and the date.", "Open the test and enter marks (or Import: download the class template, fill marks, upload it).", "Save. Ranks, grades and report cards are worked out automatically."], link: "/app/exams" },
  { id: "report_cards", title: "Print or send report cards", roles: TEACHING, words: "report card result marksheet print send parents remarks", steps: ["Open Tests and open the test.", "Add remarks if you like (or Write remarks with AI).", "Use Report cards to print or download them, or send each to the parent on WhatsApp."], link: "/app/exams" },
  { id: "grading", title: "Change the grading scale", roles: MANAGERS, words: "grading grade scale pass marks percentage cbse", steps: ["Open Settings → Grading.", "Change the grade boundaries or the pass percentage.", "Save. Test results use it straight away."], link: "/app/settings/grading" },
  { id: "promote", title: "Start a new academic year and promote students", roles: MANAGERS, words: "promote new year session next class academic year", steps: ["Open Settings → Academic year.", "Click Promote students.", "Check where each class goes (and anyone who stays back or leaves), then confirm."], link: "/app/settings/year" },
  { id: "add_staff", title: "Add a teacher or other staff", roles: MANAGERS, words: "add teacher staff member accountant admin invite team", steps: ["Open Settings → Team & roles.", "Click Add member: their email, name and role (teacher, accountant or admin).", "Share the password with them, or they sign in with their mobile number."], link: "/app/settings/team" },
  { id: "assign_classes", title: "Assign classes to a teacher", roles: MANAGERS, words: "assign class teacher subject teaching classes section", steps: ["Open Settings → Team & roles.", "Find the teacher and click Assign classes.", "Choose the classes (as class teacher) or the subjects they teach, and save."], link: "/app/settings/team" },
  { id: "classes", title: "Set up classes, sections and subjects", roles: MANAGERS, words: "classes sections subjects batch standard setup", steps: ["Open Settings → Classes & subjects.", "Add each class with its sections and subjects.", "Save. Students, attendance and tests use this list."], link: "/app/settings/classes" },
  { id: "whatsapp", title: "Set up WhatsApp messages", roles: MANAGERS, words: "whatsapp setup api message parents connect", steps: ["Open Settings → WhatsApp.", "Use simple mode (opens WhatsApp with the message ready) or connect the WhatsApp Business API to send automatically.", "Turn on the messages you want: receipts, reminders, absence alerts, report cards."], link: "/app/settings/whatsapp" },
  { id: "notice", title: "Post a notice", roles: TEACHING, words: "notice circular announcement holiday parents staff", steps: ["Open Notices and click New notice.", "Choose Staff or Parents (and the classes for parents).", "Write it, or use Write with AI, then Post notice."], link: "/app/notices" },
  { id: "homework", title: "Give homework", roles: TEACHING, words: "homework assignment give class work", steps: ["Open Homework and click Give homework.", "Choose the class, subject and dates and describe it (Write with AI can help).", "Save, and send it to parents on WhatsApp if you like."], link: "/app/homework" },
  { id: "timetable", title: "Make the timetable", roles: MANAGERS, words: "timetable periods schedule time table", steps: ["Open Timetable and choose the class.", "Click Add period: day, time, subject and teacher.", "Teachers see their periods on their dashboard."], link: "/app/timetable" },
  { id: "school_profile", title: "Change the school's name, logo or contact details", roles: MANAGERS, words: "logo school name address phone profile letterhead", steps: ["Open Settings → School profile.", "Change the details, or upload the logo (it's cropped to fit).", "Save. Receipts and report cards use it."], link: "/app/settings/school" },
  { id: "receipt_design", title: "Change how receipts or report cards look", roles: MANAGERS, words: "receipt design report card design colour signature print", steps: ["Open Settings → Receipts (or Report cards).", "Choose the colour, what's shown, titles and signatures; the preview updates as you go.", "Save."], link: "/app/settings/receipts" },
  { id: "account", title: "Change your password or mobile number", roles: ALL, words: "password mobile number phone account change otp login", steps: ["Open Settings → My account.", "Change your name, password or mobile number (a code is sent to verify it).", "Save."], link: "/app/settings/account" },
  { id: "ai_on", title: "Turn on the AI assistant", roles: MANAGERS, words: "ai assistant zia turn on enable ask", steps: ["Open Settings → AI assistant.", "Tick that you understand records are sent to Google Gemini to answer.", "Click Turn on for my school. Every member can then use Ask Zia."], link: "/app/settings/ai" },
  { id: "presentation", title: "Make a presentation", roles: ALL, words: "presentation slides ppt powerpoint deck ptm review", steps: ["Open Presentations and click New presentation.", "Choose From a topic, Test results for a PTM or Monthly school review.", "Click any text on a slide to change it; download as PowerPoint or PDF, or Present."], link: "/app/slides" },
  { id: "install_app", title: "Install Zaref Campus as an app", roles: ALL, words: "install app phone home screen download mobile", steps: ["On the dashboard, tap Install app (or your browser's Install / Add to home screen).", "Open Zaref Campus from your home screen like any app."], link: "/app/dashboard" },
];

const words = (s) => String(s ?? "").toLowerCase().split(/[^\p{L}\p{N}]+/u).filter((w) => w.length > 2);

/** The guides that best match `topic`, among those this role can do. */
export function findGuides(role, topic, n = 2) {
  const q = words(topic);
  const mine = GUIDES.filter((g) => g.roles.includes(role));
  const scored = mine
    .map((g) => {
      const hay = new Set(words(`${g.title} ${g.words}`));
      return { g, score: q.reduce((t, w) => t + (hay.has(w) ? 2 : [...hay].some((h) => h.startsWith(w.slice(0, 5))) ? 1 : 0), 0) };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, n)
    .map(({ g }) => ({ title: g.title, steps: g.steps, link: g.link }));
  return scored.length ? { guides: scored } : { guides: [], available: mine.map((g) => g.title) };
}
