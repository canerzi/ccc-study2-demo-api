const fs = require("fs");
const path = require("path");

const LIBRARY_PATH = path.join(
  __dirname,
  "..",
  "data",
  "CCC_Study2_AI_QA_Library_v4.json"
);

function loadV4Library() {
  const raw = fs.readFileSync(LIBRARY_PATH, "utf8");
  const lib = JSON.parse(raw);

  if (!lib.metadata || lib.metadata.schema_version !== "v4") {
    throw new Error("Expected v4 QA library.");
  }

  if (!lib.canonicals || Object.keys(lib.canonicals).length === 0) {
    throw new Error("No v4 canonicals found.");
  }

  return lib;
}

function normalize(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokenize(text) {
  const stopwords = new Set([
    "the", "a", "an", "and", "or", "but", "if", "then", "to", "of", "in",
    "on", "for", "with", "is", "are", "was", "were", "be", "being", "been",
    "i", "me", "my", "we", "our", "you", "your", "it", "this", "that",
    "do", "does", "did", "can", "could", "should", "would", "what", "why",
    "how", "when", "where", "which", "who", "will", "just", "really"
  ]);

  return normalize(text)
    .split(" ")
    .filter((t) => t.length >= 3 && !stopwords.has(t));
}

function chooseWrapperType(userQuestion) {
  const q = normalize(userQuestion);

  const pushbackMarkers = [
    "really",
    "supposedly",
    "i doubt",
    "skeptical",
    "why should i trust",
    "isn t this just",
    "but surely",
    "but isn t",
    "just dumping",
    "just writing a check",
    "is this really",
    "really backed"
  ];

  const warmerMarkers = [
    "i m not sure",
    "i am not sure",
    "i don t know",
    "i think",
    "what should i",
    "what do you think",
    "i want",
    "i d like",
    "i would like",
    "i d rather",
    "i would rather",
    "feels",
    "feel",
    "is there a way",
    "can i make",
    "i have"
  ];

  if (pushbackMarkers.some((m) => q.includes(m))) return "pushback";
  if (warmerMarkers.some((m) => q.includes(m))) return "warmer";
  return "neutral";
}

function renderAnswer(canonical, wrapperType) {
  const wrappers = canonical.wrappers || {};
  const wrapper = wrappers[wrapperType] || wrappers.neutral || null;
  const base = canonical.canonical_answer || "";

  if (!wrapper || !wrapper.full_template) {
    return base;
  }

  return wrapper.full_template.replace("[CANONICAL]", base).trim();
}

function scoreCanonical(userQuestion, canonical) {
  const qTokens = tokenize(userQuestion);
  const qSet = new Set(qTokens);

  if (qTokens.length === 0) return 0;

  let score = 0;

  const titleTokens = tokenize(canonical.title || "");
  const answerTokens = tokenize(canonical.canonical_answer || "");

  for (const t of titleTokens) {
    if (qSet.has(t)) score += 3;
  }

  for (const t of answerTokens) {
    if (qSet.has(t)) score += 1;
  }

  const inputs = canonical.inputs || [];

  for (const input of inputs) {
    const phrasing = input.phrasing || "";
    const inputTokens = tokenize(phrasing);
    let overlap = 0;

    for (const t of inputTokens) {
      if (qSet.has(t)) overlap += 1;
    }

    if (overlap > 0) {
      score += overlap * 5;
    }

    const normalizedInput = normalize(phrasing);
    const normalizedQuestion = normalize(userQuestion);

    if (
      normalizedInput &&
      (normalizedQuestion.includes(normalizedInput) ||
        normalizedInput.includes(normalizedQuestion))
    ) {
      score += 25;
    }
  }

  return score;
}

function getDomainName(lib, domainId) {
  const domain = (lib.domain_map || []).find((d) => d.id === domainId);
  return domain ? domain.cluster_domain : domainId;
}

function findFallbackRefusalCanonical(lib) {
  const canonicals = Object.values(lib.canonicals || {});
  return (
    lib.canonicals["A10.1"] ||
    canonicals.find((a) => a.domain === "D10") ||
    null
  );
}

function routeQuestionV4(userQuestion) {
  const lib = loadV4Library();
  const question = String(userQuestion || "").trim();

  if (!question) {
    return {
      ok: false,
      type: "empty",
      message: "Please type a donation-related question before submitting."
    };
  }

  const wrapperType = chooseWrapperType(question);
  const canonicals = Object.values(lib.canonicals);

  const scored = canonicals
    .map((canonical) => ({
      canonical,
      score: scoreCanonical(question, canonical)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  const MIN_SCORE = 8;
  const chosen = best && best.score >= MIN_SCORE ? best.canonical : null;

  if (!chosen) {
    const fallback = findFallbackRefusalCanonical(lib);

    if (!fallback) {
      return {
        ok: false,
        type: "refusal",
        message:
          "This assistant is designed only to answer donation-relevant questions for this study. Please ask about disaster donations, cash donations, in-kind donations, logistics, timing, recipient needs, trust, or donation usefulness."
      };
    }

    return {
      ok: true,
      type: "refusal",
      answer_id: fallback.answer_id,
      domain: fallback.domain,
      domain_name: getDomainName(lib, fallback.domain),
      wrapper_type: wrapperType,
      score: best ? best.score : 0,
      title: fallback.title,
      answer: renderAnswer(fallback, wrapperType)
    };
  }

  return {
    ok: true,
    type: "answer",
    answer_id: chosen.answer_id,
    domain: chosen.domain,
    domain_name: getDomainName(lib, chosen.domain),
    wrapper_type: wrapperType,
    score: best.score,
    title: chosen.title,
    answer: renderAnswer(chosen, wrapperType)
  };
}

function getV4ClientConfig() {
  const lib = loadV4Library();

  return {
    schema_version: lib.metadata.schema_version,
    counts: lib.metadata.counts,
    domains: lib.domain_map || [],
    topic_chips: lib.topic_chips || [],
    welcome_close: lib.welcome_close || []
  };
}

module.exports = {
  loadV4Library,
  routeQuestionV4,
  getV4ClientConfig
};
