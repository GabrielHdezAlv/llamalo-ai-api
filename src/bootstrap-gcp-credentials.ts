/**
 * Debe importarse antes que el resto de la app.
 * En Render, si montas el secret en /etc/secrets/google-cloud-credentials.json,
 * las librerías @google-cloud/* usarán GOOGLE_APPLICATION_CREDENTIALS.
 */
import { existsSync } from 'fs';

const RENDER_GCP_SECRET = '/etc/secrets/google-cloud-credentials.json';

if (existsSync(RENDER_GCP_SECRET)) {
  process.env.GOOGLE_APPLICATION_CREDENTIALS = RENDER_GCP_SECRET;
}
