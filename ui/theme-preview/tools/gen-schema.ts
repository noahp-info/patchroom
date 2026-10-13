// Usage: node --experimental-strip-types tools/gen-schema.ts [--check]
// Writes ../src/theme/theme.schema.json from the token list (run prettier on it after).
// With --check, fails if the file no longer matches the token list.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { TOKEN_GROUPS, TOKEN_GROUP_NOTES } from '../../src/theme/tokens.ts';

const COLOR = '^(transparent|#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8}))$';

export function buildSchema(): object {
  const props: Record<string, object> = {};
  for (const [group, keys] of Object.entries(TOKEN_GROUPS)) {
    for (const k of keys) {
      props[k] = {
        $ref: '#/$defs/color',
        description: TOKEN_GROUP_NOTES[group as keyof typeof TOKEN_GROUPS],
      };
    }
  }
  const tokenMap = {
    type: 'object',
    additionalProperties: false,
    required: Object.keys(props),
    properties: props,
  };
  return {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:patchroom:schema:theme:1',
    title: 'Patchroom color theme',
    description:
      'A color theme: one complete token set for light and one for dark. Colors only. A base (layout, type, chrome) is chosen separately.',
    type: 'object',
    additionalProperties: false,
    required: ['schemaVersion', 'id', 'name', 'modes'],
    properties: {
      $schema: { type: 'string' },
      schemaVersion: { const: 1 },
      id: { type: 'string', pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
      name: { type: 'string', minLength: 1, maxLength: 60 },
      description: { type: 'string' },
      author: { type: 'string' },
      license: { type: 'string' },
      modes: {
        type: 'object',
        additionalProperties: false,
        required: ['light', 'dark'],
        properties: { light: { $ref: '#/$defs/tokens' }, dark: { $ref: '#/$defs/tokens' } },
      },
    },
    $defs: {
      color: {
        type: 'string',
        pattern: COLOR,
        description: '#rgb, #rgba, #rrggbb, #rrggbbaa, or transparent.',
      },
      tokens: tokenMap,
    },
  };
}

export const SCHEMA_PATH = fileURLToPath(
  new URL('../../src/theme/theme.schema.json', import.meta.url),
);
export const schemaText = () => JSON.stringify(buildSchema(), null, 2) + '\n';

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--check')) {
    if (
      JSON.stringify(JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'))) !==
      JSON.stringify(buildSchema())
    ) {
      console.error('theme.schema.json is stale. Run tools/gen-schema.ts');
      process.exit(1);
    }
  } else {
    writeFileSync(SCHEMA_PATH, schemaText());
  }
}
