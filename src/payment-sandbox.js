function requireSandboxSecret(secret) {
  if (typeof secret !== "string" || !/^sk_test_[A-Za-z0-9]+$/.test(secret)) {
    const error = new Error("A PayMongo sandbox secret key is required; live payments are disabled.");
    error.status = 503;
    throw error;
  }
}

module.exports = { requireSandboxSecret };
