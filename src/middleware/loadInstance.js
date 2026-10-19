/**
 * Load an instance for a route and attach it to `req.instance`.
 *
 * Tenant isolation is applied here: a key that is not entitled to the instance
 * receives a 404, identical to the response for an instance that does not
 * exist, so instance ids cannot be probed across tenants.
 */
export function createInstanceLoader({ instanceService }) {
  return async function loadInstance(req, _res, next) {
    try {
      req.instance = await instanceService.getOwned(req.auth, req.params.instanceId);
      next();
    } catch (error) {
      next(error);
    }
  };
}
