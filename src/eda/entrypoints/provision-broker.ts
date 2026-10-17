import "dotenv/config";
import { connectBroker, provisionTopology } from "../infrastructure/broker.js";

async function provision() {
  if (process.env.VITAL_EDA_PROVISION_BROKER !== "true") throw new Error("Broker provisioning requires explicit opt-in.");
  const connection = await connectBroker(process.env.VITAL_RABBITMQ_PROVISION_URL ?? "", process.env.VITAL_RABBITMQ_CA_FILE ?? "");
  try { await provisionTopology(connection); } finally { await connection.close(); }
}
void provision().catch(() => { console.error("VITAL broker provisioning failed; verify configuration and scoped provisioner permissions."); process.exitCode = 1; });
