import { config, fields, collection } from '@keystatic/core';

export default config({
  storage: {
    kind: 'local',
  },
  collections: {
    fleet: collection({
      label: 'Fleet Spec',
      slugField: 'title',
      path: 'src/content/fleet/*',
      format: { contentField: 'content' },
      schema: {
        title: fields.slug({ name: { label: 'Title' } }),
        capacityTonnage: fields.integer({ label: 'Capacity (Tonnage)' }),
        axleConfiguration: fields.text({ label: 'Axle Configuration' }),
        militaryCleared: fields.checkbox({ label: 'Military Cleared', defaultValue: false }),
        equipmentSpecs: fields.array(fields.text({ label: 'Key Spec' }), {
          label: 'Equipment Features',
          itemLabel: (props) => props.value || 'Feature',
        }),
        content: fields.mdx({ label: 'Description Content' }),
      },
    }),
  },
});
