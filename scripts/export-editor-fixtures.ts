/**
 * Write the schema fixtures that stencilpy tests load, using the editor's own
 * exporter. Run from the editor directory:
 *
 *   npx vite-node ../scripts/export-editor-fixtures.ts
 *
 * CI regenerates them and fails when the committed files differ, so the editor's
 * YAML output cannot drift away from what stencilpy accepts.
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { schemaToYaml } from '../editor/src/lib/yaml-export';
import type { StencilSchema } from '../editor/src/lib/types';

const outputDir = resolve(import.meta.dirname ?? __dirname, '../stencilpy/tests/fixtures/editor');

const fixtures: Array<{ file: string; schema: StencilSchema }> = [
  {
    file: 'scalar_and_list.stencil.yaml',
    schema: {
      name: 'lab_report',
      description: 'Scalars, a list with a spacer row and a computed field',
      discriminator: { cell: 'A1', cells: ['A1'] },
      versions: [
        {
          discriminatorValue: 'v1.0',
          fields: [
            { name: 'report_id', cell: 'B1' },
            { name: 'site', cell: 'B2' },
            { name: 'weight', cell: 'E3', type: 'float' },
            { name: 'height', cell: 'E4', type: 'float' },
            { name: 'bmi', computed: '{weight} / ({height} ** 2)' },
            { name: 'readings', range: 'D5:D', type: 'list[float]', openEnded: true, blankRows: 2 },
          ],
          validation: {
            report_id: { pattern: '^RPT-\\d+$' },
            readings: { min: 0, max: 1000 },
          },
        },
      ],
    },
  },
  {
    file: 'table_horizontal.stencil.yaml',
    schema: {
      name: 'results',
      description: 'A table with an explicit column mapping',
      discriminator: { cell: 'A1', cells: ['A1'] },
      versions: [
        {
          discriminatorValue: 'v1.0',
          fields: [
            {
              name: 'results_table',
              range: 'A3:D',
              type: 'table',
              openEnded: true,
              columns: { A: 'analyte', B: 'value', C: 'unit', D: 'flag' },
            },
          ],
          validation: {},
        },
      ],
    },
  },
  {
    file: 'table_vertical.stencil.yaml',
    schema: {
      name: 'matrix',
      description: 'A transposed table: one record per column',
      discriminator: { cell: 'A1', cells: ['A1'] },
      versions: [
        {
          discriminatorValue: 'v1.0',
          fields: [
            {
              name: 'matrix_table',
              range: 'A3:D',
              type: 'table',
              tableOrientation: 'vertical',
              openEnded: true,
              columns: { '3': 'record_name', '4': 'hb', '5': 'wbc' },
            },
          ],
          validation: {},
        },
      ],
    },
  },
];

mkdirSync(outputDir, { recursive: true });
for (const fixture of fixtures) {
  const path = resolve(outputDir, fixture.file);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, schemaToYaml(fixture.schema));
  console.log(`wrote ${path}`);
}
