/**
 * Connector discovery.
 *
 * Clients must be able to learn, from the API rather than from documentation,
 * which connector supports which operation. Capabilities are produced by the
 * connector classes themselves so they cannot drift from implementation.
 */
import { Router } from 'express';
import { ROUTE_SCOPES } from '../config/security.js';
import { ConnectorType } from '../services/instance.service.js';
import { ok } from '../utils/respond.js';

export function createConnectorsRouter({ config, connectionService, requireScopes, rateLimit }) {
  const router = Router();

  router.get('/', rateLimit.read, requireScopes(...ROUTE_SCOPES.instancesRead), async (_req, res) => {
    ok(res, {
      default: config.connectors.default,
      connectors: {
        [ConnectorType.CLOUD_API]: connectionService.describeConnectorCapabilities(ConnectorType.CLOUD_API),
        [ConnectorType.WEB]: connectionService.describeConnectorCapabilities(ConnectorType.WEB),
      },
      notes: [
        'The official WhatsApp Business Platform (Cloud API) is the default production connector.',
        'The WhatsApp Web connector is disabled by default and requires documented written authorization to enable.',
        'Capabilities reflect what each connector can genuinely do; unsupported operations return CAPABILITY_NOT_SUPPORTED (501).',
      ],
    });
  });

  return router;
}
