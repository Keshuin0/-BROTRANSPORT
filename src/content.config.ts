import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const fleet = defineCollection({
  loader: glob({ pattern: '**/[^_]*.{md,mdx}', base: './src/content/fleet' }),
  schema: z.object({
    title: z.string(),
    capacityTonnage: z.number(),
    axleConfiguration: z.string(),
    superloadSpec: z.boolean().default(false),
    equipmentSpecs: z.array(z.string()).optional(),
  })
});

export const collections = { fleet };
