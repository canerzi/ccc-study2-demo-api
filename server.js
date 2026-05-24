import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import OpenAI from "openai";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const MODEL = process.env.OPENAI_MODEL || "gpt-4o";
const qa = JSON.parse(fs.readFileSync("./data/qa_library.json", "utf8"));

const openai = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "20kb" }));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));
app.use(express.static("public"));

const answerIds = Object.keys(qa.answers);
const bridgeIds = Object.keys(qa.bridges);
const refusalIds = Object.keys(qa.refusals);

function normalize(s) {
  return String(s || "").toLowerCase();
}

function deterministicFallback(question) {
  const q = normalize(question);

  if (/tax|deduct|investment|salary|my money|personal finance|financial/.test(q)) {
    return { type: "refusal", refusal_id: "R1", confidence: 0.35, reason: "fallback_tax_finance" };
  }
  if (/politic|government blame|policy|election|war/.test(q)) {
    return { type: "refusal", refusal_id: "R3", confidence: 0.35, reason: "fallback_political" };
  }
  if (/medical advice|medicine|doctor|injury|health advice/.test(q)) {
    return { type: "refusal", refusal_id: "R4", confidence: 0.35, reason: "fallback_medical" };
  }

  if (/cash|item|bundle|buy|better|choose|should|donat/.test(q)) {
    return { type: "answer", q_id: "Q4.1", confidence: 0.72, reason: "fallback_cash_modality" };
  }
  if (/need|shortage|priority|most|local|surplus|avoid/.test(q)) {
    if (/avoid|surplus|not needed/.test(q)) return { type: "answer", q_id: "Q2.2", confidence: 0.75, reason: "fallback_surplus" };
    return { type: "answer", q_id: "Q2.1", confidence: 0.75, reason: "fallback_needs" };
  }
  if (/deliver|time|fast|arrive|reach|ship|hour|day|convert/.test(q)) {
    return { type: "answer", q_id: "Q1.1", confidence: 0.74, reason: "fallback_delivery" };
  }
  if (/money|where|overhead|audit|trust|transparent|fee|waste|misuse|legit/.test(q)) {
    if (/misuse|verify|track/.test(q)) return { type: "answer", q_id: "Q3.3", confidence: 0.76, reason: "fallback_verification" };
    return { type: "answer", q_id: "Q3.1", confidence: 0.74, reason: "fallback_money" };
  }

  return { type: "fallback", confidence: 0.2, reason: "fallback_unclear" };
}

function composeAnswer(mapping) {
  if (!mapping || mapping.type === "fallback") {
    return {
      answer: qa.messages?.fallback_no_cluster_match?.text || "I can help with local needs, delivery times, where the money goes, or cash vs items decisions.",
      q_id: null,
      bridge_id: null,
      refusal_id: null
    };
  }

  if (mapping.type === "refusal") {
    const r = qa.refusals[mapping.refusal_id] || qa.refusals.R5;
    return {
      answer: r.refusal_text + " " + (r.redirect_suggestion ? "(" + r.redirect_suggestion + ")" : ""),
      q_id: null,
      bridge_id: null,
      refusal_id: r.refusal_id
    };
  }

  if (mapping.type === "bridge") {
    const b = qa.bridges[mapping.bridge_id];
    const targetId = b?.target_q_id || mapping.q_id;
    const a = qa.answers[targetId];
    const bridge = b?.bridge_phrasing || "";
    const answerText = a?.answer || qa.messages?.fallback_no_cluster_match?.text || "";
    return {
      answer: bridge.includes("[") ? bridge.replace(/\[[^\]]+\]/, answerText) : (bridge + " " + answerText),
      q_id: targetId,
      bridge_id: b?.bridge_id || null,
      refusal_id: null
    };
  }

  const a = qa.answers[mapping.q_id] || qa.answers["Q4.1"];
  return {
    answer: a.answer,
    q_id: a.q_id,
    bridge_id: null,
    refusal_id: null
  };
}

function schema() {
  return {
    type: "object",
    additionalProperties: false,
    properties: {
      type: { type: "string", enum: ["answer", "bridge", "refusal", "fallback"] },
      q_id: { type: ["string", "null"], enum: [...answerIds, null] },
      bridge_id: { type: ["string", "null"], enum: [...bridgeIds, null] },
      refusal_id: { type: ["string", "null"], enum: [...refusalIds, null] },
      confidence: { type: "number", minimum: 0, maximum: 1 },
      reason: { type: "string" }
    },
    required: ["type", "q_id", "bridge_id", "refusal_id", "confidence", "reason"]
  };
}

function routerPrompt() {
  return `
You are a semantic router for a disaster-donation demo.

Your job:
- Read the user's question.
- Return ONLY a routing JSON object.
- Do NOT answer the user.
- Do NOT invent any facts.
- Route to the closest pre-vetted answer, bridge, refusal, or fallback.

The frontend will display controlled spreadsheet answers only.

Available answer IDs:
${answerIds.map(id => `${id}: ${qa.answers[id].canonical_question}`).join("\n")}

Available bridge IDs:
${bridgeIds.map(id => `${id}: ${qa.bridges[id].example} -> ${qa.bridges[id].target_q_id}`).join("\n")}

Available refusal IDs:
${refusalIds.map(id => `${id}: ${qa.refusals[id].trigger_topic}`).join("\n")}

Routing rules:
- High confidence >= 0.70: type="answer" and choose q_id.
- Medium confidence 0.40-0.69: type="bridge" and choose bridge_id.
- Low confidence < 0.40 but out-of-scope: type="refusal" and choose refusal_id.
- Low confidence unclear: type="fallback".
- For topic chips, choose the obvious matching Q ID.
- If the question asks "cash vs items", "what should I choose", or "should I buy X", prefer Q4.1 unless it clearly asks about bundles.
- If it asks about current shortages or what is needed, prefer Q2.1.
- If it asks what not to donate or surplus, prefer Q2.2.
- If it asks about delivery speed, prefer Q1.1.
- If it asks about overhead, prefer Q3.1.
- If it asks about partners, prefer Q3.2.
- If it asks about tracking, verification, audit trail, or misuse, prefer Q3.3.
`;
}

app.post("/api/chat", async (req, res) => {
  const question = String(req.body?.question || "").slice(0, 500);
  const arm = String(req.body?.arm || "").slice(0, 50);
  const turnNumber = Number(req.body?.turnNumber || 0);
  const cart = req.body?.cart && typeof req.body.cart === "object" ? req.body.cart : {};

  if (!question.trim()) {
    return res.status(400).json({ error: "question required" });
  }

  let mapping;

  if (!openai) {
    mapping = deterministicFallback(question);
  } else {
    try {
      const response = await openai.responses.create({
        model: MODEL,
        input: [
          { role: "system", content: routerPrompt() },
          { role: "user", content: JSON.stringify({ question, arm, turnNumber, cart }) }
        ],
        text: {
          format: {
            type: "json_schema",
            name: "study2_qa_route",
            strict: true,
            schema: schema()
          }
        },
        temperature: 0,
        max_output_tokens: 160
      });

      mapping = JSON.parse(response.output_text);
    } catch (err) {
      console.error("OpenAI routing failed, falling back:", err);
      mapping = deterministicFallback(question);
    }
  }

  const composed = composeAnswer(mapping);

  res.json({
    ...mapping,
    ...composed,
    source: openai ? "gpt4o_router_plus_spreadsheet_answer" : "deterministic_fallback_plus_spreadsheet_answer",
    model: openai ? MODEL : null
  });
});

app.get("/api/health", (_, res) => {
  res.json({
    ok: true,
    hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),
    answers: answerIds.length,
    bridges: bridgeIds.length,
    refusals: refusalIds.length
  });
});

app.listen(PORT, () => {
  console.log(`CCC Study 2 demo running at http://localhost:${PORT}`);
  console.log(`OpenAI key loaded: ${Boolean(process.env.OPENAI_API_KEY)}`);
});
