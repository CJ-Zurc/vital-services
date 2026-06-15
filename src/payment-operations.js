const crypto = require("crypto");
const { pool, withTransaction } = require("./db");

function stableJson(value) {
  if (Array.isArray(value)) return value.map(stableJson);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, stableJson(value[key])]),
    );
  }
  return value;
}

function requestHash(payload) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stableJson(payload)))
    .digest("hex");
}

const postgresLedger = {
  async claim({ operationKey, operationType, payload, correlationId }) {
    const hash = requestHash(payload);
    return withTransaction(async (client) => {
      const inserted = await client.query(
        `INSERT INTO payment_operations
          ("id", "operationKey", "operationType", "requestHash", "status", "correlationId", "createdAt", "updatedAt")
         VALUES ($1, $2, $3, $4, 'pending', $5, NOW(), NOW())
         ON CONFLICT ("operationKey") DO NOTHING
         RETURNING *`,
        [crypto.randomUUID(), operationKey, operationType, hash, correlationId || null],
      );
      if (inserted.rowCount === 1) {
        return { owner: true, operation: inserted.rows[0] };
      }

      const existing = await client.query(
        `SELECT * FROM payment_operations WHERE "operationKey" = $1 FOR UPDATE`,
        [operationKey],
      );
      const operation = existing.rows[0];
      if (!operation || operation.requestHash !== hash || operation.operationType !== operationType) {
        const error = new Error("Operation key was already used for a different request.");
        error.status = 409;
        throw error;
      }
      if (operation.status === "failed") {
        const updated = await client.query(
          `UPDATE payment_operations SET status = 'pending', "updatedAt" = NOW() WHERE "operationKey" = $1 RETURNING *`,
          [operationKey],
        );
        return { owner: true, operation: updated.rows[0] };
      }
      return { owner: false, operation };
    });
  },

  async finish(operationKey, status, result, errorMessage) {
    const providerId =
      result?.checkoutSessionId ||
      result?.refundId ||
      result?.paymentIntentId ||
      null;
    const updated = await pool.query(
      `UPDATE payment_operations
       SET "status" = $2,
           "providerId" = $3,
           "result" = $4::jsonb,
           "error" = $5,
           "updatedAt" = NOW()
       WHERE "operationKey" = $1
       RETURNING *`,
      [
        operationKey,
        status,
        providerId,
        result ? JSON.stringify(result) : null,
        errorMessage || null,
      ],
    );
    return updated.rows[0];
  },
};

function operationResponse(operation) {
  return {
    operationStatus: operation.status,
    data: operation.result || null,
    error: operation.error || null,
  };
}

async function runPaymentOperation({
  ledger = postgresLedger,
  operationKey,
  operationType,
  payload,
  correlationId,
  execute,
}) {
  if (!operationKey) {
    const error = new Error("operationKey is required.");
    error.status = 400;
    throw error;
  }

  const claim = await ledger.claim({
    operationKey,
    operationType,
    payload,
    correlationId,
  });
  if (!claim.owner) return operationResponse(claim.operation);

  try {
    const result = await execute();
    return operationResponse(
      await ledger.finish(operationKey, "completed", result, null),
    );
  } catch (error) {
    const status = error.response ? "failed" : "unknown";
    await ledger.finish(operationKey, status, null, error.message);
    error.operationStatus = status;
    throw error;
  }
}

module.exports = { postgresLedger, requestHash, runPaymentOperation };
