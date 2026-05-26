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

// ---------------------------------------------------------------------------
// Stage-1 domain intent detection
//
// Before scoring all 53 canonicals (lexical bag-of-words), we first check for
// explicit domain markers. This catches obvious intent ("transparency of cash"
// = D5 Trust, not D7 Local procurement) and prevents the scorer from getting
// fooled by word-overlap with answer text.
//
// Rule priority is by array order. The first rule whose marker is found in the
// normalized user input wins. D5 is listed first because "trust/transparency"
// terms appear inside many other domains' answer text; catching them up-front
// keeps them in D5.
//
// If no markers match, we fall back to scoring all canonicals (the v1 behavior)
// so we don't make the router strictly worse than it was.
// ---------------------------------------------------------------------------
function detectDomainIntent(userQuestion) {
  const q = normalize(userQuestion);
  const rules = [
    {
      domain: "D5",
      label: "Trust",
      markers: [
        "trust",
        "transparency",
        "transparent",
        "accountability",
        "accountable",
        "where does my money go",
        "where my money goes",
        "used properly",
        "misuse",
        "overhead",
        "audit",
        "audited",
        "receipt",
        "reporting",
        "corruption",
        "fraud",
        "scam"
      ]
    },
    {
      domain: "D9",
      label: "Who to donate to",
      markers: [
        "who should i donate to",
        "where should i donate",
        "which organization",
        "which ngo",
        "what organization",
        "what ngo",
        "local ngo",
        "international ngo",
        "local or international",
        "red cross",
        "charity"
      ]
    },
    {
      domain: "D2",
      label: "Item fit / needs",
      markers: [
        "most needed",
        "what is needed",
        "what's needed",
        "needed right now",
        "urgent needs",
        "which items",
        "what items",
        "blankets",
        "clothes",
        "food",
        "water",
        "hygiene",
        "tent",
        "medicine"
      ]
    },
    {
      domain: "D1",
      label: "Cash vs in-kind",
      markers: [
        "cash or in kind",
        "cash or inkind",
        "cash vs in kind",
        "cash vs inkind",
        "cash or goods",
        "money or goods",
        "money or stuff",
        "donate cash or",
        "donate money or",
        "in kind",
        "inkind"
      ]
    },
    {
      domain: "D4",
      label: "Logistics burden",
      markers: [
        "send supplies directly",
        "why not send supplies",
        "logistics",
        "sorting",
        "storage",
        "warehouse",
        "transport",
        "congestion",
        "second disaster",
        "unsolicited"
      ]
    },
    {
      domain: "D3",
      label: "Acute timing",
      markers: [
        "how fast",
        "how quickly",
        "first day",
        "first 48 hours",
        "first two days",
        "right after",
        "acute phase",
        "after two weeks",
        "timing",
        "arrive"
      ]
    }
  ];
  for (const rule of rules) {
    if (rule.markers.some((m) => q.includes(normalize(m)))) {
      return rule.domain;
    }
  }
  return null;
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
  const allCanonicals = Object.values(lib.canonicals);

  // Stage 1: domain intent detection (explicit markers, deterministic).
  const detectedDomain = detectDomainIntent(question);

  // Stage 2: score only candidates within the detected domain. If no domain
  // matched, fall back to scoring all canonicals (v1 behavior).
  const candidateCanonicals = detectedDomain
    ? allCanonicals.filter((a) => a.domain === detectedDomain)
    : allCanonicals;

  const scored = candidateCanonicals
    .map((canonical) => ({
      canonical,
      score: scoreCanonical(question, canonical)
    }))
    .sort((a, b) => b.score - a.score);

  const best = scored[0];

  // When a domain was detected, relax the minimum-score floor — we already
  // have intent signal, so even a low lexical-overlap answer in the right
  // domain is better than falling through to refusal.
  const MIN_SCORE = detectedDomain ? 0 : 8;
  const chosen = best && best.score >= MIN_SCORE ? best.canonical : null;

  if (!chosen) {
    const fallback = findFallbackRefusalCanonical(lib);

    if (!fallback) {
      return {
        ok: false,
        type: "refusal",
        detected_domain: detectedDomain,
        message:
          "This assistant is designed only to answer donation-relevant questions for this study. Please ask about disaster donations, cash donations, in-kind donations, logistics, timing, recipient needs, trust, or donation usefulness."
      };
    }

    return {
      ok: true,
      type: "refusal",
      detected_domain: detectedDomain,
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
    detected_domain: detectedDomain,
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
