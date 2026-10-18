import type { Pool } from "pg";
import { createBillingAuthority } from "../appointment/appointment-billing.js";
import { createPaymentModule } from "./payment.js";
import { createPaymongoProvider } from "./payment-provider.js";
import { createPaymentStore } from "./payment-store.js";
import { createPaymentAssociation } from "./payment-association.js";
import { createRescheduleAuthority } from "../appointment/appointment-saga-authority.js";

export function paymentRuntime(databases: { corePool: Pool; integrationsPool: Pool }, environment = process.env) {
  if (environment.VITAL_EDA_PAYMENT_ENABLED !== "true") {
    if (environment.VITAL_EDA_PAYMENT_RECONCILE_ENABLED === "true") throw new Error("PAYMENT_RECONCILIATION_WITHOUT_OWNER");
    return undefined;
  }
  if (environment.VITAL_EDA_ENABLED !== "true") throw new Error("PAYMENT_RUNTIME_DISABLED");
  const appOrigin = environment.VITAL_PAYMENT_APP_ORIGIN;
  if (!appOrigin || environment.NODE_ENV === "production" && !appOrigin.startsWith("https://")) throw new Error("PAYMENT_APP_ORIGIN_REQUIRED");
  return createPaymentModule({ enabled: true, appOrigin, billing: createBillingAuthority(databases.corePool),
    association:createPaymentAssociation(databases.integrationsPool,createRescheduleAuthority(databases.corePool)),
    store: createPaymentStore(databases.integrationsPool), provider: createPaymongoProvider({ secret: environment.PAYMONGO_SECRET_KEY ?? "" }) });
}
