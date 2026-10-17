import { Router } from 'express';
import { DomainError, type Actor } from '../contracts/actor.js';
import type { createAppointmentCommandPreparation } from '../modules/appointment/appointment-command-preparation.js';

export type AppointmentCommandPreparationRuntime = ReturnType<typeof createAppointmentCommandPreparation>;
// Mount at /internal/v1/appointments/command-preparations BEFORE the /:id owner route.
export function createAppointmentCommandPreparationRouter(runtime?: AppointmentCommandPreparationRuntime) {
  const router = Router();
  router.use((_req, res, next) => {
    if (!runtime) return next(new DomainError(503, 'APPOINTMENT_OWNER_DISABLED', 'Appointment extraction is disabled.'));
    if (!res.locals.actor) return next(new DomainError(401, 'ACTOR_REQUIRED', 'Verified actor required.'));
    next();
  });
  router.post('/', async (req, res) => {
    if (!res.locals.command) throw new DomainError(401, 'COMMAND_METADATA_REQUIRED', 'Signed command required.');
    const data = await runtime!.prepare(res.locals.actor as Actor, req.body);
    res.json({ success: true, contractVersion: 1, data });
  });
  router.get('/:id', async (req, res) => {
    const data = await runtime!.read(res.locals.actor as Actor, req.params.id);
    res.json({ success: true, contractVersion: 1, data });
  });
  return router;
}
