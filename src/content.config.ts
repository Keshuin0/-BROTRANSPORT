import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

const fleet = defineCollection({
  loader: glob({ pattern: '**/*.mdx', base: './src/content/fleet' }),
  schema: z.object({
    title: z.string(),
    equipmentType: z.enum(['dry_van', 'reefer', 'flatbed']),
    capacityLbs: z.number().int(),
    capacityTonnage: z.number(),
    interiorDimensions: z.string(),
    axleConfiguration: z.string(),
    tempRange: z.string().optional(),
    equipmentSpecs: z.array(z.string()),
  }),
});

export const collections = { fleet };
