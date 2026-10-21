import { Router } from 'express';
import { DomainError } from '../contracts/actor.js';
import type { AppointmentExtras } from '../modules/appointment/appointment-extras.js';

export function createAppointmentExtrasRouter(owner?: AppointmentExtras) {
  const router = Router();
  router.get('/admin/doctors/:id/ratings', async (req, res) => {
    if (!owner || !res.locals.actor) throw new DomainError(403, 'ACTOR_REQUIRED', 'Verified actor required.');
    res.json({ success: true, contractVersion: 1, data: await owner.ratings(res.locals.actor, req.params.id, req.query) });
  });
  router.get('/:id/chief-complaint', async (req, res) => {
    if (!owner || !res.locals.actor) throw new DomainError(403, 'ACTOR_REQUIRED', 'Verified actor required.');
    res.json({ success: true, contractVersion: 1, data: await owner.complaint(res.locals.actor, req.params.id, req.query) });
  });
  router.post('/:id/chief-complaint', async (req, res) => {
    if (!owner || !res.locals.actor || !res.locals.command) throw new DomainError(403, 'ACTOR_REQUIRED', 'Signed command required.');
    res.json({ success: true, contractVersion: 1, data: await owner.correctComplaint(res.locals.actor, req.params.id, res.locals.command, req.body) });
  });
  router.post('/:id/feedback', async (req, res) => {
    if (!owner) throw new DomainError(503, 'APPOINTMENT_OWNER_DISABLED', 'Appointment owner unavailable.');
    if (!res.locals.actor || !res.locals.command) throw new DomainError(401, 'ACTOR_REQUIRED', 'Signed command required.');
    res.json({ success: true, contractVersion: 1, data: await owner.feedback(res.locals.actor, req.params.id, res.locals.command, req.body) });
  });
  router.get('/patients/:id/intakes', async (req, res) => {
    if (!owner) throw new DomainError(503, 'APPOINTMENT_OWNER_DISABLED', 'Appointment owner unavailable.');
    if (!res.locals.actor) throw new DomainError(401, 'ACTOR_REQUIRED', 'Signed actor required.');
    res.json({ success: true, contractVersion: 1, data: await owner.intakes(res.locals.actor, req.params.id, req.query) });
  });
  return router;
}
