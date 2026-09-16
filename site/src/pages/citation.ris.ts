import meta from '../data/meta.json';
import { risRecord } from '../lib/citation';

export function GET(): Response {
  return new Response(risRecord(meta.version), {
    headers: {
      'Content-Type': 'application/x-research-info-systems; charset=utf-8',
      'Content-Disposition': 'attachment; filename="leningrad-codex-tei.ris"',
    },
  });
}
