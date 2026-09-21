"use strict";
/**
 * Offline mock of the TypeSafe System One API (POST /v1/systemone).
 * Deterministic answers, no network beyond localhost. Used by the offline
 * test suite to run the REAL bridge end-to-end without any paid API.
 */

const http = require("node:http");

/**
 * Create a mock upstream.
 * @param {object} [opts]
 * @param {number} [opts.status]  HTTP status to always answer (e.g. 429)
 * @param {string} [opts.body]    raw body to answer with (overrides answers)
 * @returns {Promise<{server, url, requests: object[], close: ()=>Promise<void>}>}
 */
function startMockUpstream(opts = {}) {
  const state = { requests: [] };
  const server = http.createServer((req, res) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      state.requests.push({
        method: req.method,
        url: req.url,
        auth: req.headers.authorization || "",
        body: safeParse(raw),
      });

      if (opts.status) {
        if (opts.status === 429) res.setHeader("Retry-After", "0");
        res.writeHead(opts.status, { "Content-Type": "application/json" });
        return res.end(opts.body || JSON.stringify({ error: { message: "mock failure" } }));
      }

      let parsed = {};
      try {
        parsed = JSON.parse(raw || "{}");
      } catch {}
      const questions = parsed.questions || {};
      const answers = {};
      for (const [id, q] of Object.entries(questions)) {
        if (q.type === "noul") {
          answers[id] = {
            type: "noul",
            noul: /urgent/i.test(q.instructions || "") ? 0.9 : 0.2,
          };
        } else if (q.type === "score") {
          answers[id] = {
            type: "score",
            score: 3,
            confidence: 0.8,
            legend: { "0": "low", "3": "high" },
          };
        } else {
          const first = q.criteria && Object.keys(q.criteria)[0];
          answers[id] = {
            type: "choice",
            choice: typeof first === "string" ? first : "yes",
            confidence: 0.9,
            probabilities: q.criteria
              ? Object.fromEntries(Object.keys(q.criteria).map((k) => [k, k === first ? 0.9 : 0.05]))
              : { yes: 0.9, no: 0.05 },
          };
        }
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          model: "jev-mock-1.0.0",
          answers,
          usage: { input_tokens: 42, output_tokens: 7 },
        })
      );
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      resolve({
        server,
        url: `http://127.0.0.1:${server.address().port}`,
        requests: state.requests,
        close: () => new Promise((r) => server.close(r)),
      });
    });
  });
}

function safeParse(raw) {
  try {
    return JSON.parse(raw || "{}");
  } catch {
    return { raw };
  }
}

module.exports = { startMockUpstream };
