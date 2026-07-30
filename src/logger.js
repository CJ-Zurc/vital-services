const { randomUUID } = require("node:crypto");

const priorities = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function configuredLevel() {
  const value = String(process.env.LOG_LEVEL || "info").toLowerCase();
  return priorities[value] ? value : "info";
}

function log(level, event, fields = {}) {
  if (process.env.HTTP_LOGGING_ENABLED === "false") return;
  if (priorities[level] < priorities[configuredLevel()]) return;

  const entry = JSON.stringify({
    timestamp: new Date().toISOString(),
    level,
    event,
    ...fields,
  });

  if (level === "error") console.error(entry);
  else if (level === "warn") console.warn(entry);
  else console.log(entry);
}

function errorFields(error) {
  const cause = error?.cause;
  return {
    errorName: error?.name,
    errorMessage: error?.message || String(error),
    causeCode: cause?.code || error?.code,
    causeMessage: cause?.message,
    causeAddress: cause?.address,
    causePort: cause?.port,
  };
}

function safeTarget(input) {
  try {
    const url = new URL(input);
    return `${url.origin}${url.pathname}`;
  } catch {
    return String(input).split("?")[0];
  }
}

function requestLogger(req, res, next) {
  const startedAt = Date.now();
  const requestId = req.get("x-correlation-id") || randomUUID();
  req.requestId = requestId;
  res.set("X-Correlation-ID", requestId);

  res.on("finish", () => {
    const level =
      res.statusCode >= 500 ? "error" : res.statusCode >= 400 ? "warn" : "info";
    log(level, "http.inbound.completed", {
      method: req.method,
      path: req.path,
      status: res.statusCode,
      durationMs: Date.now() - startedAt,
      requestId,
    });
  });

  next();
}

async function loggedFetch(service, input, init = {}) {
  const startedAt = Date.now();
  const method = init.method || "GET";
  const target = safeTarget(input);

  try {
    const response = await fetch(input, init);
    log(response.ok ? "info" : "warn", "http.outbound.completed", {
      service,
      method,
      target,
      status: response.status,
      durationMs: Date.now() - startedAt,
    });
    return response;
  } catch (error) {
    log("error", "http.outbound.failed", {
      service,
      method,
      target,
      durationMs: Date.now() - startedAt,
      ...errorFields(error),
    });
    throw error;
  }
}

module.exports = {
  errorFields,
  log,
  loggedFetch,
  requestLogger,
  safeTarget,
};
