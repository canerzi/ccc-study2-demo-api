import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import XLSX from "xlsx";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT = path.resolve(__dirname, "..");

function die(message) {
  console.error("\nERROR: " + message + "\n");
  process.exit(1);
}

function norm(value) {
  if (value === undefined || value === null) return "";
  return String(value).trim();
}

function keyify(value) {
  return norm(value)
    .toLowerCase()
    .replace(/[–—]/g, "-")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function findWorkbookPath() {
  const argPath = process.argv.slice(2).find(x => !x.startsWith("--"));
  if (argPath) return path.resolve(PROJECT_ROOT, argPath);

  const preferred = path.join(PROJECT_ROOT, "data", "CCC_Study2_AI_QA_Library_v1.xlsx");
  if (fs.existsSync(preferred)) return preferred;

  const candidates = [path.join(PROJECT_ROOT, "data"), PROJECT_ROOT];
  for (const dir of candidates) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir)
      .filter(f => /\.xlsx$/i.test(f) && !/^~\$/.test(f))
      .sort((a, b) => {
        const aScore = /CCC_Study2_AI_QA_Library_v1\.xlsx$/i.test(a) ? 0 : /QA|Library|CCC/i.test(a) ? 1 : 2;
        const bScore = /CCC_Study2_AI_QA_Library_v1\.xlsx$/i.test(b) ? 0 : /QA|Library|CCC/i.test(b) ? 1 : 2;
        return aScore - bScore || a.localeCompare(b);
      });
    if (files.length) return path.join(dir, files[0]);
  }
  return null;
}

function sheetRows(wb, sheetName) {
  const ws = wb.Sheets[sheetName];
  if (!ws) die(`Missing required sheet: ${sheetName}`);
  return XLSX.utils.sheet_to_json(ws, { header: 1, defval: "", blankrows: false });
}

function findHeaderRow(rows, expectedHeaders, minHits = 2) {
  const expected = expectedHeaders.map(keyify);
  for (let i = 0; i < rows.length; i++) {
    const rowKeys = rows[i].map(keyify);
    const hits = expected.filter(h => rowKeys.includes(h)).length;
    if (hits >= Math.min(minHits, expected.length)) return i;
  }
  die(`Could not find header row containing: ${expectedHeaders.join(", ")}`);
}

function tableObjects(rows, expectedHeaders, minHits = 2) {
  const headerIdx = findHeaderRow(rows, expectedHeaders, minHits);
  const headers = rows[headerIdx].map(h => keyify(h));
  const out = [];
  for (let r = headerIdx + 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row.some(cell => norm(cell))) continue;
    const obj = {};
    headers.forEach((h, c) => {
      if (h) obj[h] = row[c] ?? "";
    });
    out.push(obj);
  }
  return out;
}

function clusterIdFromText(text) {
  const m = norm(text).match(/C\d+/i);
  return m ? m[0].toUpperCase() : "";
}

function extractClusters(wb) {
  const rows = tableObjects(sheetRows(wb, "Clusters"), ["Cluster ID", "Name"], 2);
  const clusters = {};
  for (const r of rows) {
    const id = norm(r.cluster_id).toUpperCase();
    if (!id || !/^C\d+/.test(id)) continue;
    clusters[id] = {
      id,
      name: norm(r.name),
      description: norm(r.description) || norm(r.sub_clusters_in_v3),
      sub_clusters: norm(r.sub_clusters_in_v3),
      total_qas: Number(r.total_q_as) || null,
      trust_route: norm(r.trust_route) || norm(r.trust_route_triggered),
      trigger_keywords: norm(r.trigger_keywords_examples),
      sem_tie: norm(r.holguin_sem_tie_in)
    };
  }
  return clusters;
}

function extractAnswers(wb) {
  const rows = tableObjects(sheetRows(wb, "Q&A Library"), ["Q ID", "Cluster", "Canonical question phrasing", "Pre-vetted answer"], 3);
  const answers = {};
  for (const r of rows) {
    const id = norm(r.q_id);
    if (!id || !/^Q/i.test(id)) continue;
    const clusterText = norm(r.cluster);
    answers[id] = {
      q_id: id,
      cluster: clusterText,
      cluster_id: clusterIdFromText(clusterText),
      sub_cluster: norm(r.sub_cluster),
      sub_topic: norm(r.sub_topic),
      canonical_question: norm(r.canonical_question_phrasing),
      answer: norm(r.pre_vetted_answer),
      words: Number(r.words) || null,
      regret_framed: norm(r.regret),
      notes: norm(r.notes),
      status: norm(r.status)
    };
  }
  return answers;
}

function extractTopicChips(wb) {
  const rows = tableObjects(sheetRows(wb, "Topic Chips"), ["Chip #", "Visible label"], 2);
  const chips = [];
  for (const r of rows) {
    const label = norm(r.visible_label);
    const qid = norm(r.default_q_a) || norm(r.default_q_and_a) || norm(r.routes_to_likely_q_a) || norm(r.routes_to_likely_q_and_a) || norm(r.target_q_a) || norm(r.target_q_and_a) || norm(r.q_id);
    if (!label || !qid) continue;
    chips.push({
      chip_number: Number(r.chip) || Number(r.chip_) || chips.length + 1,
      label,
      cluster: norm(r.routes_to_cluster),
      q_id: qid
    });
  }
  return chips;
}

function extractMessages(wb) {
  const rows = tableObjects(sheetRows(wb, "Welcome+Close"), ["Message type", "Trigger", "Text"], 3);
  const messages = {};
  for (const r of rows) {
    const messageType = norm(r.message_type);
    const text = norm(r.text);
    if (!messageType || !text) continue;
    messages[keyify(messageType)] = { trigger: norm(r.trigger), text };
  }
  return messages;
}

function extractBridges(wb) {
  const rows = tableObjects(sheetRows(wb, "Bridges"), ["Bridge ID", "Target Q&A", "Bridge phrasing"], 3);
  const bridges = {};
  for (const r of rows) {
    const id = norm(r.bridge_id);
    if (!id || !/^B\d+\./.test(id)) continue;
    bridges[id] = {
      bridge_id: id,
      example: norm(r.source_adjacent_question_example),
      target_cluster: norm(r.target_cluster),
      target_q_id: norm(r.target_q_a) || norm(r.target_q_and_a),
      bridge_phrasing: norm(r.bridge_phrasing)
    };
  }
  return bridges;
}

function extractRefusals(wb) {
  const rows = tableObjects(sheetRows(wb, "Refusals"), ["Refusal ID", "Trigger topic", "Refusal text"], 3);
  const refusals = {};
  for (const r of rows) {
    const id = norm(r.refusal_id);
    if (!id || !/^R\d+/.test(id)) continue;
    refusals[id] = {
      refusal_id: id,
      trigger_topic: norm(r.trigger_topic),
      refusal_text: norm(r.refusal_text),
      redirect_suggestion: norm(r.redirect_suggestion)
    };
  }
  return refusals;
}

function extractSystemPrompt(wb) {
  const rows = tableObjects(sheetRows(wb, "System Prompt"), ["Section", "Content"], 2);
  const prompt = {};
  for (const r of rows) {
    const section = norm(r.section);
    const content = norm(r.content);
    if (!section || !content) continue;
    prompt[section] = content;
  }
  return prompt;
}

function extractRoutingSpec(wb) {
  if (!wb.Sheets["Routing Spec"]) return [];
  const rows = tableObjects(sheetRows(wb, "Routing Spec"), ["Routing level", "Trigger", "Action"], 3);
  return rows
    .filter(r => norm(r.routing_level) || norm(r.trigger) || norm(r.action))
    .map(r => ({
      routing_level: norm(r.routing_level),
      trigger: norm(r.trigger),
      action: norm(r.action)
    }));
}

function validateLibrary(lib) {
  const errors = [];
  const answerIds = new Set(Object.keys(lib.answers));
  if (Object.keys(lib.clusters).length < 1) errors.push("No clusters found.");
  if (answerIds.size < 1) errors.push("No Q&A answers found.");
  if (Object.keys(lib.refusals).length < 1) errors.push("No refusals found.");

  for (const chip of lib.topic_chips) {
    if (!answerIds.has(chip.q_id)) errors.push(`Topic chip ${chip.label} points to missing q_id ${chip.q_id}`);
  }
  for (const bridge of Object.values(lib.bridges)) {
    if (!answerIds.has(bridge.target_q_id)) errors.push(`Bridge ${bridge.bridge_id} points to missing target_q_id ${bridge.target_q_id}`);
  }
  for (const answer of Object.values(lib.answers)) {
    if (!answer.answer) errors.push(`Answer ${answer.q_id} has empty answer text.`);
  }
  if (errors.length) die("Library validation failed:\n- " + errors.join("\n- "));
}

const workbookPath = findWorkbookPath();
if (!workbookPath) die("No .xlsx workbook found. Put the QA workbook in the project root or data/ folder, or pass its path as an argument.");
if (!fs.existsSync(workbookPath)) die(`Workbook not found: ${workbookPath}`);

const wb = XLSX.readFile(workbookPath, { cellDates: false });

const library = {
  metadata: {
    source_file: path.basename(workbookPath),
    purpose: "Study 2 demo QA library. GPT routes to IDs; answers stay controlled.",
    schema_version: "v3-compatible",
    generated_at: new Date().toISOString()
  },
  clusters: extractClusters(wb),
  answers: extractAnswers(wb),
  topic_chips: extractTopicChips(wb),
  messages: extractMessages(wb),
  bridges: extractBridges(wb),
  refusals: extractRefusals(wb),
  system_prompt: extractSystemPrompt(wb),
  routing_spec: extractRoutingSpec(wb)
};

validateLibrary(library);

const outputPath = path.join(PROJECT_ROOT, "data", "qa_library.json");
fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, JSON.stringify(library, null, 2), "utf8");

console.log("\nQA library regenerated successfully.");
console.log(`Source: ${path.relative(PROJECT_ROOT, workbookPath)}`);
console.log(`Output: ${path.relative(PROJECT_ROOT, outputPath)}`);
console.log(`Schema: ${library.metadata.schema_version}`);
console.log(`Clusters: ${Object.keys(library.clusters).length}`);
console.log(`Answers: ${Object.keys(library.answers).length}`);
console.log(`Topic chips: ${library.topic_chips.length}`);
console.log(`Bridges: ${Object.keys(library.bridges).length}`);
console.log(`Refusals: ${Object.keys(library.refusals).length}\n`);
