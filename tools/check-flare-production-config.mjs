import { validateProductionServiceConfig } from './release-evidence.mjs';

const errors = validateProductionServiceConfig(process.env);
if (errors.length > 0) {
  console.error(`production-config=BLOCKED missing=${errors.join(';')}`);
  process.exitCode = 2;
} else {
  console.log('production-config=PASS api=tls+auth+mongo indexer=mongo+rediss keeper=rediss+all-jobs');
}
