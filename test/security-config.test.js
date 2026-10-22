import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));

const read = (relPath) => fs.readFileSync(path.join(projectRoot, relPath), 'utf8');

test('no API keys are hardcoded as fallback values in source code', () => {
  const imeiService = read('src/imeiMetadataService.js');
  const imeiApiClient = read('src/imeiApiClient.js');
  const phoneValidation = read('src/phoneValidation.js');

  assert.doesNotMatch(imeiService, /IMEI_API_KEY\s*\|\|\s*['"][^'"]+['"]/);
  assert.doesNotMatch(imeiApiClient, /IMEI_API_KEY\s*\|\|\s*['"][^'"]+['"]/);
  assert.doesNotMatch(phoneValidation, /PHONE_VALIDATION_ACCESS_KEY\s*\|\|\s*['"][^'"]+['"]/);
});
